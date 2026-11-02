const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('./local_tools/dxm-uploader/_internal/playwright/driver/package');

// All writes are intercepted. These fixtures never create or queue real jobs.
const source = {id:'a'.repeat(32),title:'20261027-003136-001',task_no:'IMG-TEST-001',batch_no:'BATCH-TEST',workflow_id:'sweater-print-set-v2',workflow_mode:'single_image_chat_v1',status:'4 张已保存，待检查',batch_phase:'saved'};
const blocked = {id:'b'.repeat(32),title:'20261027-003136-002',task_no:'IMG-TEST-002',batch_no:'BATCH-TEST',eligible:false,reason:'原任务仍在执行',retained_count:0,regenerate_count:0};
const result = {at:new Date().toISOString(),mode:'isolated headless browser with all write requests intercepted',checks:[],requests:[],unexpected_writes:[],page_errors:[]};
const evidence = path.join(__dirname,'data/verification/20261029-partial-repair-ui-regression');
fs.mkdirSync(evidence,{recursive:true});

(async()=>{
  const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  let page;
  let previewFails = false;
  try {
    page = await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'});
    page.setDefaultTimeout(15000);
    page.on('pageerror',error=>result.page_errors.push(error.message));
    await page.route('**/api/**',async route=>{
      const request = route.request();
      const url = new URL(request.url());
      if(request.method()==='GET'){
        if(url.pathname==='/api/image-jobs') return route.fulfill({json:{jobs:[source],summary:{total_jobs:1,saved_jobs:1}}});
        if(url.pathname==='/api/image-jobs/'+source.id) return route.fulfill({json:{job:source}});
        return route.continue();
      }
      const body = request.postDataJSON();
      result.requests.push({path:url.pathname,body,workbench_header:request.headers()['x-workbench']});
      if(url.pathname==='/api/image-jobs/repair-preview'){
        if(previewFails) return route.fulfill({status:400,json:{error:'原图文件校验失败'}});
        const one = !!body.ids;
        const matching = [{...source,eligible:true,reason:'',retained_count:3,regenerate_count:body.step_keys.length},...(one?[]:[blocked])];
        return route.fulfill({json:{ok:true,matching,matched_count:matching.length,eligible_count:1,blocked_count:one?0:1,step_keys:body.step_keys,message:'预览完成'}});
      }
      if(url.pathname==='/api/image-jobs/repair-prepare') return route.fulfill({json:{ok:true,jobs:[{id:'c'.repeat(32),title:'修复测试',repair_source_id:source.id}],skipped:[],errors:[],prepared_count:1,message:'已准备 1 套修复任务'}});
      result.unexpected_writes.push({path:url.pathname,body});
      return route.abort('blockedbyclient');
    });
    await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded',timeout:45000});
    await page.locator('.connection.connected').waitFor();
    await page.getByRole('group',{name:'工作模式',exact:true}).getByRole('button',{name:'专业模式',exact:true}).click();
    await page.getByRole('button',{name:'上新',exact:true}).click();await page.getByRole('button',{name:'GPT 批量生图',exact:true}).click();
    const section = page.locator('details').filter({has:page.getByLabel('部分修改任务名称', {exact:true})});
    await section.locator(':scope > summary').click();
    const query = page.getByLabel('部分修改任务名称',{exact:true});
    const preview = section.getByRole('button',{name:'预览匹配任务',exact:true});
    assert(await preview.isDisabled());
    result.checks.push({case:'blank filter cannot target every job',passed:true});

    await query.fill('20261027-003136');
    await preview.click();
    const area = page.getByLabel('部分修改预览',{exact:true});
    await area.waitFor();
    assert((await area.innerText()).includes('匹配 2 套 · 可修改 1 套 · 暂不可修改 1 套'));
    assert((await area.innerText()).includes('原任务仍在执行'));
    assert.equal(result.requests.length,1);
    assert.equal(result.requests[0].path,'/api/image-jobs/repair-preview');
    assert.deepEqual(result.requests[0].body,{title_query:'20261027-003136',batch_no:'',step_keys:['hanger','flatlay'],source_results_root:''});
    result.checks.push({case:'name preview lists eligible and blocked without creating jobs',passed:true});

    await section.getByText('更多保存设置',{exact:true}).click();
    await section.getByLabel('部分修改原成图文件夹',{exact:true}).fill('D:/测试成图');
    assert.equal(await area.count(),0);
    await section.getByLabel('部分修改结果文件夹',{exact:true}).fill('D:/测试修复');
    result.checks.push({case:'changing source or output folder invalidates previous preview',passed:true});
    await query.fill('20261027-003136-001');
    assert.equal(await area.count(),0);
    result.checks.push({case:'changing filter invalidates previous preview',passed:true});
    await preview.click();
    await area.waitFor();
    await area.getByRole('button',{name:'创建 1 套修复任务',exact:true}).click();
    await page.getByLabel('部分修改结果',{exact:true}).waitFor();
    const prepared = result.requests.find(row=>row.path==='/api/image-jobs/repair-prepare');
    assert.deepEqual(prepared.body.ids,[source.id]);
    assert.deepEqual(prepared.body.step_keys,['hanger','flatlay']);
    assert.equal(prepared.body.source_results_root,'D:/测试成图');
    assert.equal(prepared.body.output_folder,'D:/测试修复');
    assert(Array.isArray(prepared.body.browsers) && prepared.body.browsers.length>0);
    assert.equal(prepared.workbench_header,'local');
    assert(!result.requests.some(row=>row.path==='/api/gpt-extension' || row.path.includes('reset')));
    result.checks.push({case:'prepare submits only eligible preview ids and never starts or resets jobs',passed:true});

    await section.getByLabel('衣架展示（半高领）',{exact:true}).uncheck();
    await section.getByLabel('平铺图（半高领）',{exact:true}).uncheck();
    assert(await preview.isDisabled());
    await section.getByLabel('平铺图（半高领）',{exact:true}).check();
    await preview.click();
    await area.waitFor();
    assert.deepEqual(result.requests.at(-1).body.step_keys,['flatlay']);
    result.checks.push({case:'single-step repair selection and no-empty selection enforced',passed:true});

    const task = page.getByRole('article',{name:'任务 '+source.task_no,exact:true});
    await task.getByText('查看步骤与操作',{exact:true}).click();
    await task.getByText('任务信息与更多操作',{exact:true}).click();
    await task.getByRole('button',{name:'部分修改／补图',exact:true}).click();
    await area.waitFor();
    assert.deepEqual(result.requests.at(-1).body.ids,[source.id]);
    assert.equal(await query.inputValue(),'');
    assert((await area.innerText()).includes('匹配 1 套'));
    result.checks.push({case:'single-task shortcut targets exact id',passed:true});

    await section.screenshot({path:path.join(evidence,'repair-panel.png')});
    previewFails=true;
    await preview.click();
    await section.getByRole('alert').filter({hasText:'原图文件校验失败'}).waitFor();
    assert.equal(await area.count(),0);
    result.checks.push({case:'failed preview is shown beside controls and cannot reuse previous results',passed:true});
    assert.deepEqual(result.unexpected_writes,[]);
    assert.deepEqual(result.page_errors,[]);
    result.passed=true;
  } catch(error){
    result.passed=false;
    result.failure=error.stack;
    if(page) await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});
    process.exitCode=1;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(evidence,'ui-verification.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  }
})();
