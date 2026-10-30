const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={module:{exports:{}},URL};
vm.runInNewContext(fs.readFileSync('gpt_chrome_extension/content.js','utf8'),context);
const api=context.module.exports;
const task={job_id:'a'.repeat(32),workflow_mode:'single_image_chat_v1',workflow_input_mode:'single_source_edit',
 step_number:1,step_token:'single-source',prompt_marker:'WBSTEP-source',attachments:[{name:'01-source-original.png'}]};
assert.equal(api.attachmentItems(task).length,1);
assert.equal(api.attachmentEvidence(task,{searchable:'01-source-original.png',imageCount:1,thumbnailCount:1,uploading:false}).ready,true);
for(const [imageCount,thumbnailCount,uploading] of [[0,0,false],[2,2,false],[1,1,true],[1,2,false]]){
 assert.equal(api.attachmentEvidence(task,{searchable:'',imageCount,thumbnailCount,uploading}).ready,false,'Missing, extra or uploading attachments must stop');
}
const ordinary={...task,workflow_input_mode:''};
assert.equal(api.attachmentEvidence(ordinary,{searchable:'',imageCount:1,thumbnailCount:1,uploading:false}).ready,false,'Normal template workflows still require two images');
const two={...ordinary,attachments:[{name:'01-template.png'},{name:'02-reference.png'}]};
assert.equal(api.attachmentEvidence(two,{searchable:'',imageCount:2,thumbnailCount:2,uploading:false}).ready,true);
assert.equal(api.downloadTask(task,1).step_token,'single-source');
console.log('Single-source edit requires exactly one stable attachment; ordinary workflows retain two-image checks.');
