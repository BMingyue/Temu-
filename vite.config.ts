import {sites} from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import {defineConfig} from 'vite';
export default defineConfig({
 css:{postcss:{plugins:[tailwindcss()]}},
 server:{
  host:'127.0.0.1',port:5173,strictPort:true,
  watch:{ignored:[
   '**/data/**','**/runtime/**','**/.migration/**','**/.*.tmpdir/**',
   '**/local_tools/**/runtime/**','**/local_tools/**/logs/**','**/local_tools/**/state/**',
  ]},
  proxy:{'/api':{target:'http://127.0.0.1:18769'}},
 },
 plugins:[vinext(),sites()],
});
