const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const evidence = path.join(__dirname, 'data/verification/20261029-source-edit-ui');
fs.mkdirSync(evidence, {recursive:true});
const source='D:\\Desktop\\毛衣1027-半高领修复';
const output='D:\\Desktop\\毛衣1027-正背面修复';
const items=['A款/01-main.png','A款/02-back.png','B款/01-main.png','B款/02-back.png'].map((name,i)=>({path:source+'\\'+name.replaceAll('/','\\'),relative_path:name,product_folder:name.split('/')[0],source_name:name.split('/')[1],sha256:String(i).repeat(64),folder_signature:name[0].repeat(64)}));
const preset={id:'sweater-front-back-fix-v1',label:'毛衣正背面 · 半高领与细节局部修复',mode:'single_source_edit',description:'只修改主画面领口与火焰圈内细节；右侧五个小圆窗保持原样。',prompt:'SOURCE_EDIT_PROMPT_TO_KEEP_FOLDED',source_names:['01-main.png','02-back.png']};
const result={at:new Date().toISOString(),mode:'isolated headless browser; all writes intercepted',checks:[],requests:[],unexpected_writes:[],page_errors:[]};
(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'});
  page.setDefaultTimeout(20000);page.on('pageerror',e=>result.page_errors.push(e.message));
  let failNext=false;
  try {
    await page.route('**/api/**',async route=>{
      const req=route.request(),u=new URL(req.url());
      if(req.method()==='GET'){
        if(u.pathname==='/api/image-jobs/source-edit-presets')return route.fulfill({json:{presets:[preset]}});
        if(u.pathname==='/api/image-jobs')return route.fulfill({json:{jobs:[],summary:{total_jobs:0}}});
        return route.continue();
      }
      const body=req.postDataJSON();result.requests.push({path:u.pathname,body,header:req.headers()['x-workbench']});
      if(u.pathname==='/api/image-jobs/source-edit-scan')return route.fulfill({json:{ok:true,source_folder:body.source_folder,items,skipped:[{folder:'已手修条纹款',reason:'发现ChatGPT前缀的已修改图片，整款排除'}],folder_count:3,file_count:4,message:'找到4张待修图，已排除1款手工修复'}});
      if(u.pathname==='/api/image-jobs/source-edit-prepare'){
        if(failNext){failNext=false;return route.fulfill({status:409,json:{error:'原图在扫描后发生变化，请重新扫描'}})}
        return route.fulfill({json:{ok:true,batch_no:'EDIT-UI-TEST',prepared_count:body.items.length,queued_count:body.items.length,jobs:body.items.map((item,i)=>({id:String(i).padStart(32,'0'),title:item.relative_path,source_relative_path:item.relative_path,result_folder:output+'\\'+item.product_folder+'\\'+item.source_name})),skipped:[],errors:[],message:'已创建单图独立任务并排队，原图保持不变'}});
      }
      result.unexpected_writes.push({path:u.pathname,body});return route.abort('blockedbyclient');
    });
    await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded',timeout:45000});
    await page.locator('.connection.connected').waitFor();
    await page.getByRole('group',{name:'工作模式',exact:true}).getByRole('button',{name:'专业模式',exact:true}).click();
    await page.getByRole('button',{name:'上新',exact:true}).click();await page.getByRole('button',{name:'GPT 批量生图',exact:true}).click();
    await page.getByRole('button',{name:'原图一对一修复',exact:true}).click();
    const panel=page.getByRole('region',{name:'原图一对一修复',exact:true});await panel.waitFor();
    assert.equal(await panel.getByLabel('待修图片所在目录',{exact:true}).inputValue(),source);
    assert.equal(await panel.getByLabel('修复成品保存目录',{exact:true}).inputValue(),output);
    await panel.getByRole('option',{name:preset.label,exact:true}).waitFor({state:'attached'});
    assert.equal(await panel.getByLabel('原图局部修复提示词',{exact:true}).isVisible(),false);
    assert((await panel.innerText()).includes('右侧五个小圆窗保持原样'));
    assert((await panel.innerText()).includes('03-hanger')===false);
    result.checks.push('独立原图修复入口与专用模板，默认源/独立输出，提示词折叠且小圆窗保留');
    await panel.getByText('查看／编辑本次修复提示词',{exact:true}).click();
    await panel.getByLabel('原图局部修复提示词',{exact:true}).fill('本次精确局部修改提示词');
    await panel.getByRole('button',{name:'扫描待修正背图',exact:true}).click();
    await panel.getByRole('heading',{name:'待修 4 张 · 已选 0 张',exact:true}).waitFor();
    assert.equal(result.requests.at(-1).path,'/api/image-jobs/source-edit-scan');
    assert.equal(result.requests.at(-1).body.source_folder,source);assert.equal(result.requests.at(-1).body.preset_id,preset.id);
    assert(await panel.getByRole('button',{name:'开始选中的 0 张修复',exact:true}).isDisabled());
    assert.equal(await panel.getByRole('checkbox',{name:/选择修复/}).count(),4);
    result.checks.push('专用扫描仅返回01/02，显示排除数；扫描后默认不选且不能直接启动');
    await panel.getByRole('button',{name:'仅选第一款（最多两张）',exact:true}).click();
    assert.equal(await panel.getByRole('checkbox',{name:/选择修复/}).filter({visible:true}).count(),4);
    assert.equal(await panel.getByRole('checkbox',{name:'选择修复 A款/01-main.png',exact:true}).isChecked(),true);
    assert.equal(await panel.getByRole('checkbox',{name:'选择修复 A款/02-back.png',exact:true}).isChecked(),true);
    assert.equal(await panel.getByRole('checkbox',{name:'选择修复 B款/01-main.png',exact:true}).isChecked(),false);
    await panel.getByRole('checkbox',{name:'选择修复 A款/02-back.png',exact:true}).uncheck();
    await panel.getByRole('button',{name:'开始选中的 1 张修复',exact:true}).click();
    await panel.getByText('已创建单图独立任务并排队，原图保持不变',{exact:true}).waitFor();
    let posted=result.requests.at(-1);assert.equal(posted.path,'/api/image-jobs/source-edit-prepare');assert.deepEqual(posted.body.items,[items[0]]);assert.equal(posted.body.prompt,'本次精确局部修改提示词');assert.deepEqual(posted.body.browsers,['chrome']);assert.equal(posted.body.output_folder,output);assert.equal(posted.body.start,true);assert.equal(posted.header,'local');
    result.checks.push('第一款两张试跑选择与精确单张提交，携带原扫描hash/签名、独立目录及本机请求头');
    await panel.getByRole('button',{name:'选择全部待修图',exact:true}).click();
    await panel.getByRole('checkbox',{name:'原图修复使用 Chrome',exact:true}).uncheck();
    assert(await panel.getByRole('button',{name:'开始选中的 4 张修复',exact:true}).isDisabled());
    await panel.getByRole('checkbox',{name:'原图修复使用 Chrome',exact:true}).check();
    await panel.getByRole('button',{name:'恢复修复模板提示词',exact:true}).click();
    assert.equal(await panel.getByLabel('原图局部修复提示词',{exact:true}).inputValue(),preset.prompt);
    result.checks.push('参与浏览器为空时禁发，恢复模板提示词');
    failNext=true;
    await panel.getByRole('button',{name:'开始选中的 4 张修复',exact:true}).click();
    await panel.getByRole('alert').getByText('原图在扫描后发生变化，请重新扫描',{exact:true}).waitFor();
    assert((await panel.innerText()).includes('已选 4 张'));
    result.checks.push('源图变化的后端错误明确展示，不误报已完成');
    await panel.getByLabel('待修图片所在目录',{exact:true}).fill(source+'-新目录');
    assert.equal(await panel.getByRole('heading',{name:/待修 4 张/}).count(),0);
    assert(await panel.getByRole('button',{name:'开始选中的 0 张修复',exact:true}).isDisabled());
    result.checks.push('改变源目录立即清空扫描和选择，必须重新扫描');
    await panel.getByRole('button',{name:'扫描待修正背图',exact:true}).click();
    await panel.getByRole('heading',{name:'待修 4 张 · 已选 0 张',exact:true}).waitFor();
    await panel.getByText('查看排除的文件夹（1）',{exact:true}).click();
    assert((await panel.innerText()).includes('已手修条纹款'));
    await panel.getByRole('button',{name:'仅选第一款（最多两张）',exact:true}).click();
    await panel.getByText('查看／编辑本次修复提示词',{exact:true}).click();
    await panel.screenshot({path:path.join(evidence,'source-edit-panel.png')});
    assert.equal(result.unexpected_writes.length,0);assert.equal(result.page_errors.length,0);result.passed=true;
    result.checks.push('手修排除明细可展开，未调用通用prepare/scan，无真实POST或页面异常');
  } catch(error){result.passed=false;result.error=error.stack;await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:false}).catch(()=>{});throw error}
  finally {fs.writeFileSync(path.join(evidence,'ui-verification.json'),JSON.stringify(result,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
