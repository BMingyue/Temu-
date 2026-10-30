"""Double-click launcher; reuse a healthy local instance, hide helper consoles."""
import os, subprocess, sys, time, urllib.request, webbrowser, json, ctypes, msvcrt, psutil
from pathlib import Path
from workbench_version import VERSION, identity
from workbench_processes import check_ports, BACKEND_PORT, WEB_PORT
ROOT=Path(__file__).resolve().parent
NODE=ROOT/'runtime/node.exe'
SUPERVISOR=ROOT/'service_supervisor.py'
SUPERVISOR_TASK='Temu Workbench Supervisor'
def healthy(url,needle=None,timeout=8):
 try:
  with urllib.request.urlopen(url,timeout=timeout) as r:
   data=r.read()
   return r.status==200 and (needle is None or needle.encode() in data)
 except Exception:return False
def supervisor_running():
 expected=SUPERVISOR.resolve()
 for process in psutil.process_iter():
  try:
   args=process.cmdline()
   if Path(process.exe()).name.lower() not in ('python.exe','pythonw.exe') or len(args)<2:continue
   script=Path(args[1])
   if not script.is_absolute():script=Path(process.cwd())/script
   if script.resolve()==expected:return True
  except (psutil.Error,OSError,ValueError):pass
 return False
def frontend_running():
 return any(_is_frontend(process) for process in psutil.process_iter())
def frontend_listener_is_ours():
 for connection in psutil.net_connections(kind='tcp'):
  if connection.status==psutil.CONN_LISTEN and connection.laddr and connection.laddr.port==WEB_PORT and connection.pid:
   try:return _is_frontend(psutil.Process(connection.pid))
   except psutil.Error:return False
 return False
def _is_frontend(process):
 from service_supervisor import is_our_frontend
 return is_our_frontend(process)
def clear_previous_boot_lock():
 lock=ROOT/'.vinext/dev/lock.json'
 if not lock.is_file():return
 try:
  saved=json.loads(lock.read_text(encoding='utf-8'))
  ctypes.windll.kernel32.GetTickCount64.restype=ctypes.c_ulonglong
  boot_ms=time.time()*1000-ctypes.windll.kernel32.GetTickCount64()
  stale=0<float(saved.get('startedAt',0))<boot_ms
  try:
   proc=psutil.Process(int(saved.get('pid',0)))
   stale=stale or Path(proc.exe()).resolve()!=NODE.resolve() or proc.create_time()*1000>float(saved.get('startedAt',0))+2000
  except psutil.NoSuchProcess:stale=True
  except (psutil.AccessDenied,ValueError):pass
  if Path(saved.get('cwd','')).resolve()==ROOT.resolve() and stale:
   lock.replace(lock.with_name('lock.previous-boot.json'))
 except (OSError,ValueError,TypeError):pass

def request_scheduled_supervisor():
 if (ROOT/'web-dist/index.html').is_file():return False
 flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
 try:
  result=subprocess.run(['schtasks.exe','/Run','/TN',SUPERVISOR_TASK],
                        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                        timeout=10,creationflags=flags)
  return result.returncode==0
 except (OSError,subprocess.SubprocessError):return False

def current_version_ready():
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{WEB_PORT}/api/health',timeout=4) as response:
   info=json.load(response)
  if info.get('version')!=VERSION or info.get('installation_id')!=identity(ROOT):return False
  if (ROOT/'web-dist/index.html').is_file():
   with urllib.request.urlopen(f'http://127.0.0.1:{WEB_PORT}/__workbench__/version',timeout=4) as response:
    page=json.load(response)
   if page.get('version')!=VERSION or page.get('installation_id')!=identity(ROOT):return False
  return True
 except (OSError,ValueError):return False

def main():
 if (ROOT/'web-dist/index.html').is_file():
  from install_workbench import wizard, prepare_startup
  if not (ROOT/'installation.json').is_file():
   wizard(source=ROOT)
   return
  if not prepare_startup(ROOT):return
 check_ports(ROOT)
 if frontend_listener_is_ours() and healthy(f'http://127.0.0.1:{WEB_PORT}/api/health','temu-workbench') and not current_version_ready():
  import ctypes
  if ctypes.windll.user32.MessageBoxW(0,'本目录仍运行旧版服务。现在自动关闭并重新启动？','重新启动工作台',0x24)!=6:return
  from workbench_processes import stop_services
  stop_services(ROOT)
 logs=ROOT/'data';logs.mkdir(exist_ok=True)
 startup_lock=open(logs/'startup.lock','a+b')
 startup_lock.seek(0);startup_lock.write(b'0');startup_lock.flush();startup_lock.seek(0)
 try:msvcrt.locking(startup_lock.fileno(),msvcrt.LK_NBLCK,1)
 except OSError:startup_lock.close();return
 flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
 # The supervisor holds its own singleton lock and also attaches to an already
 # healthy backend. It remains alive if the HTTP process unexpectedly exits.
 if not supervisor_running():
   if not request_scheduled_supervisor():
    with open(logs/'supervisor.log','ab') as out:
     subprocess.Popen([sys.executable,str(SUPERVISOR)],cwd=ROOT,stdout=out,stderr=out,creationflags=flags)
 # The supervisor is the sole owner of service spawning. The launcher only
 # waits for the verified D-drive frontend, avoiding a cold-start race.
 deadline=time.monotonic()+180
 while time.monotonic()<deadline:
  if frontend_listener_is_ours() and current_version_ready() and healthy(f'http://127.0.0.1:{WEB_PORT}/'):
   with open(logs/'startup.log','a',encoding='utf-8') as out:out.write(time.strftime('%Y-%m-%d %H:%M:%S')+' 启动成功：页面与数据服务已就绪\n')
   webbrowser.open(f'http://127.0.0.1:{WEB_PORT}/?release='+VERSION);return
  time.sleep(1)
 raise RuntimeError('工作台启动超时，请查看 data 文件夹中的 frontend.log 和 backend.log。')
if __name__=='__main__':
 try:main()
 except Exception as exc:
  import ctypes
  ctypes.windll.user32.MessageBoxW(0,str(exc),'织品工作台启动提示',0x10)
