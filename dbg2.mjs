import React from 'react';
import TestRenderer from 'react-test-renderer';
const { EmailAccountCard } = await import('./plugin-src/client/channels/email/index.js');
const textOf=(n)=>typeof n==='string'?n:Array.isArray(n)?n.map(textOf).join(''):n?.children?textOf(n.children):'';
const rpcCall = async () => ({ ok:true, value:{ account:null, senders:{}, knownSenders:['a@x.com'], sessions:[] } });
let r;
await TestRenderer.act(async()=>{
  r = TestRenderer.create(React.createElement(EmailAccountCard, {
    account:{ botId:'e1', state:'connected', connected:true, bot:{name:'u@qq.com'},
      allowedSenders:['a@x.com'], health:{summary:'ok'} },
    rpcCall, onReconnect(){}, onRequestRemove(){}, onConfirmRemove(){}, onCancelRemove(){},
  }));
});
const btns = r.root.findAll(n=>n.type==='button').map(b=>textOf(b.children)).filter(t=>t);
console.log('  按钮:', btns.join(' | '));
