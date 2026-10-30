"""Local browser worker. No Codex service or API key is used by this module."""
import json,os,re,threading,queue,time,uuid,hashlib
from pathlib import Path
from datetime import datetime,timezone
from urllib.parse import urlsplit

def is_login_page(url):
 return urlsplit(url).hostname in ('chatgpt.com','auth.openai.com','auth0.openai.com','accounts.google.com','login.microsoftonline.com','login.live.com','appleid.apple.com')

def classify_login(url,title,body,has_profile=False,has_composer=False):
 if re.search(r'正在进行安全验证|验证您不是自动程序|验证您是真人|Verify you are human|Checking your browser|Just a moment|Sorry, you have been blocked',title+'\n'+body,re.I):
  return '安全验证中','登录页正在进行网站安全验证。执行器保持当前页面，不刷新、不重试发送；验证通过后点击检查登录。'
 if urlsplit(url).hostname=='chatgpt.com' and has_profile and has_composer:
  return '就绪','已检测到 GPT 登录状态和输入框，可开始本地任务'
 return '等待登录','请在专用 Chrome 中完成 GPT 登录，再点击检查登录；当前登录页面会保留'

def now():return datetime.now(timezone.utc).isoformat()
def job_path(data,ident):
 if not isinstance(ident,str) or not re.fullmatch('[a-f0-9]{32}',ident):raise ValueError('任务编号无效')
 return Path(data)/'image-jobs'/ident/'job.json'
def read_job(data,ident):return json.loads(job_path(data,ident).read_text(encoding='utf-8'))
def write_job(data,job):
 p=job_path(data,job['id']);temp=p.with_suffix('.'+uuid.uuid4().hex+'.tmp');temp.write_text(json.dumps(job,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(temp,p)
def image_extension(content):
 if content.startswith(b'\x89PNG\r\n\x1a\n'):return '.png'
 if content.startswith(b'\xff\xd8\xff'):return '.jpg'
 if content.startswith(b'RIFF') and content[8:12]==b'WEBP':return '.webp'
 raise ValueError('下载内容不是 PNG/JPG/WEBP 图片，已保留临时文件供核对')
def saved_step_valid(step):
 p=Path(step.get('output',''))
 return bool(step.get('sha256') and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==step['sha256'])

class Runner:
 def __init__(self,data):
  self.data=Path(data);self.lock=threading.RLock();self.commands=queue.Queue();self.cancel=threading.Event();self.context=None;self.pw=None
  self.state={'status':'未启动','message':'打开专用生图浏览器后登录 GPT。无需 Codex 保持在线。','active_job':None,'updated_at':now()}
  self.thread=threading.Thread(target=self._worker,daemon=True);self.thread.start()
 def update(self,**values):
  with self.lock:self.state.update(values,updated_at=now())
 def snapshot(self):
  with self.lock:return dict(self.state)
 def submit(self,action,ident=None):
  with self.lock:
   if action=='stop':self.cancel.set();self.state['message']='正在暂停；已发送的任务不会自动重复发送';return self.snapshot()
   if self.state['active_job'] or self.state['status']=='启动中':raise ValueError('执行器忙碌，请等待或暂停当前任务')
   if action=='start':
    job=read_job(self.data,ident)
    if all(saved_step_valid(s) for s in job['steps']):raise ValueError('这一任务的图片均已保存，无需重复执行')
    self.state['active_job']=ident
   elif action not in ('open','check'):raise ValueError('未知执行动作')
   self.cancel.clear();self.state.update(status='启动中',message='正在连接本地执行器');self.commands.put((action,ident));return self.snapshot()
 def _worker(self):
  while True:
   action,ident=self.commands.get()
   try:
    self._open()
    if action=='start':self._run(ident)
    else:
     page=self.context.pages[-1] if self.context.pages else self.context.new_page()
     self._inspect_login(page)
   except Exception as e:self.update(status='需要处理',message=str(e)[:400])
   finally:self.update(active_job=None);self.commands.task_done()
 def _open(self):
  if self.context:
   try:
    if self.context.pages:return
   except Exception:pass
   try:self.context.close()
   except Exception:pass
   self.context=None
  if self.pw is None:
   from playwright.sync_api import sync_playwright
   self.pw=sync_playwright().start()
  self.context=self.pw.chromium.launch_persistent_context(str(self.data/'gpt-browser'),channel='chrome',headless=False,accept_downloads=True,chromium_sandbox=True,no_viewport=True)
  self.context.set_default_timeout(60000)
 def _logged_in(self,page):
  if urlsplit(page.url).hostname!='chatgpt.com':return False
  profile=page.get_by_role('button',name=re.compile('个人资料|profile',re.I))
  composer=page.get_by_role('textbox',name=re.compile('与 ChatGPT 聊天|Message ChatGPT|Ask anything',re.I))
  return profile.count()>0 and composer.count()>0
 def _inspect_login(self,page):
  # Checking status must not navigate away from an active authentication flow.
  if not is_login_page(page.url):page.goto('https://chatgpt.com/',wait_until='domcontentloaded',timeout=60000)
  page.bring_to_front()
  status,message=self._login_state(page)
  self.update(status=status,message=message)
 def _login_state(self,page):
  deadline=time.monotonic()+10
  while True:
   self._check_cancel()
   title=page.title();body=page.locator('body').inner_text(timeout=10000)[:12000]
   logged=self._logged_in(page)
   status,message=classify_login(page.url,title,body,logged,logged)
   if status in ('就绪','安全验证中') or time.monotonic()>=deadline:return status,message
   page.wait_for_timeout(500)
 def _check_cancel(self):
  if self.cancel.is_set():raise RuntimeError('已暂停。再次开始会继续已发送任务，不会自动重发。')
 def _run(self,ident):
  job=read_job(self.data,ident);job['status']='执行中';job['error']='';write_job(self.data,job)
  current=None
  try:
   total=len(job['steps'])
   for step in job['steps']:
    current=step;self._check_cancel()
    if saved_step_valid(step):continue
    self.update(status='执行中',message=f"第 {step['number']}/{total} 张：准备页面")
    page=self.context.new_page()
    existing=step.get('chat_url','')
    if step.get('phase') in ('sending','sent','waiting','downloading') and not re.fullmatch(r'https://chatgpt\.com/c/[a-zA-Z0-9-]+',existing):
     raise RuntimeError('上次发送结果不确定，未找到聊天地址；为避免重复生图，请先人工核对该张任务。')
    page.goto(existing or 'https://chatgpt.com/',wait_until='domcontentloaded',timeout=60000)
    login_status,login_message=self._login_state(page)
    if login_status!='就绪':raise RuntimeError(login_message)
    if not existing:
     composer=page.get_by_role('textbox',name=re.compile('与 ChatGPT 聊天|Message ChatGPT|Ask anything',re.I))
     if composer.count()!=1:raise RuntimeError('无法唯一识别 GPT 输入框，已停止')
     # Dedicated profile: do not replace an unexpected user draft.
     if composer.inner_text().strip() not in ('','问问 ChatGPT','Ask anything'):raise RuntimeError('专用浏览器中已有草稿，请先处理草稿后重试')
     page.get_by_role('button',name=re.compile('^添加文件等$|^Add files',re.I)).click()
     with page.expect_file_chooser(timeout=15000) as chosen:page.get_by_text(re.compile('^添加照片和文件$|^Add photos & files$',re.I)).click()
     chosen.value.set_files([step['reference'],step['template']])
     composer.fill(step['prompt'])
     # Allow attachment preparation to complete before sending.
     send=page.get_by_role('button',name=re.compile('^发送提示词$|^Send prompt$|^Send message$',re.I))
     deadline=time.monotonic()+120
     while time.monotonic()<deadline:
      self._check_cancel()
      if send.count()==1 and send.is_enabled():break
      page.wait_for_timeout(1000)
     else:raise RuntimeError('附件上传或发送按钮准备超时，请检查页面')
     self._check_cancel();step.update(phase='sending',status='正在发送');write_job(self.data,job)
     send.click();step.update(phase='sent',status='已发送',sent_at=now());write_job(self.data,job)
    self.update(message=f"第 {step['number']}/{total} 张：等待生成")
    self._wait_image(page,job,step)
    self._download(page,job,step)
    page.close()
   job['status']=f'{total} 张已保存，待检查';write_job(self.data,job);self.update(status='完成',message=f'{total} 张图片已保存到结果目录，请检查印花和构图')
  except Exception as e:
   job['status']='已暂停' if self.cancel.is_set() else '需要处理';job['error']=str(e)[:400]
   if current:current['status']=job['status']
   write_job(self.data,job);raise
 def _wait_image(self,page,job,step):
  deadline=time.monotonic()+1200;stable=0
  while time.monotonic()<deadline:
   self._check_cancel()
   if re.fullmatch(r'https://chatgpt\.com/c/[a-zA-Z0-9-]+',page.url) and step.get('chat_url')!=page.url:
    step.update(chat_url=page.url,phase='waiting',status='等待生成');write_job(self.data,job)
   image=page.get_by_role('button',name=re.compile('^已生成图片$|^Image generated$',re.I))
   stopping=page.get_by_role('button',name=re.compile('停止生成|停止流式传输|Stop generating|Stop streaming',re.I))
   if image.count()>0 and stopping.count()==0:
    stable+=1
    if stable>=3:return
   else:stable=0
   page.wait_for_timeout(2000)
  raise RuntimeError('等待生成超过 20 分钟，保留聊天地址；可继续等待，不自动重发')
 def _download(self,page,job,step):
  self._check_cancel();step.update(phase='downloading',status='正在收图');write_job(self.data,job)
  image=page.get_by_role('button',name=re.compile('^已生成图片$|^Image generated$',re.I))
  if image.count()!=1:raise RuntimeError('结果图片数量不是一张，已停止自动收图，请检查是否生成了多张')
  image.click()
  save=page.get_by_role('button',name=re.compile('^保存$|^Save$',re.I))
  if save.count()==1:
   save.click()
   download=page.get_by_role('menuitem',name=re.compile('^下载图片$|^Download image$',re.I))
  else:
   download=page.get_by_role('button',name=re.compile('^下载$|^下载图片$|^Download$|^Download image$',re.I))
  if download.count()!=1:raise RuntimeError('无法唯一识别图片下载按钮，请在当前页面核对')
  with page.expect_download(timeout=60000) as waiting:download.click()
  result=waiting.value;folder=Path(job['result_folder']);folder.mkdir(parents=True,exist_ok=True)
  tmp=folder/(f"{step['number']:02d}-"+uuid.uuid4().hex+'.part');result.save_as(tmp)
  raw=tmp.read_bytes();ext=image_extension(raw);target=folder/(f"{step['number']:02d}-"+uuid.uuid4().hex[:8]+ext);os.replace(tmp,target)
  step.update(phase='saved',status='已保存',output=str(target),sha256=hashlib.sha256(raw).hexdigest(),saved_at=now());write_job(self.data,job)

_instances={};_lock=threading.Lock()
def get_runner(data):
 key=str(Path(data).resolve())
 with _lock:
  if key not in _instances:_instances[key]=Runner(data)
  return _instances[key]
