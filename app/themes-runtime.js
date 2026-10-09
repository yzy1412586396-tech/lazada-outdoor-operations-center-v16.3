(() => {
  'use strict';
  function syncReports(){
    for(const frame of document.querySelectorAll('iframe')){
      try {
        const doc=frame.contentDocument;if(!doc?.head)continue;
        const root=doc.documentElement,parent=document.documentElement;
        root.classList.add('desktop-app','desktop-performance');
        for(const key of ['theme','effects','buttonStyle','fontFamily'])root.dataset[key]=parent.dataset[key]||'';
        for(let i=0;i<parent.style.length;i++){const key=parent.style[i];if(key.startsWith('--'))root.style.setProperty(key,parent.style.getPropertyValue(key),'important')}
        for(const [key,value]of Object.entries({'--panel':parent.style.getPropertyValue('--surface'),'--green':parent.style.getPropertyValue('--accent'),'--green2':parent.style.getPropertyValue('--accent'),'--green-soft':parent.style.getPropertyValue('--surface2')}))root.style.setProperty(key,value,'important');
        let link=doc.getElementById('shared-appearance-theme');if(!link){link=doc.createElement('link');link.id='shared-appearance-theme';link.rel='stylesheet';link.href=new URL('./themes.css',document.baseURI).href;doc.head.appendChild(link)}
      }catch{/* external frames retain their own styling */}
    }
  }
  document.addEventListener('appearance-changed',syncReports);
  function install(){document.querySelectorAll('iframe').forEach(f=>f.addEventListener('load',()=>{syncReports();setTimeout(syncReports,1000)}));syncReports();setTimeout(()=>{const panel=document.querySelector('#appearancePanel');if(panel)panel.parentElement.prepend(panel);syncReports()},1800)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
