/* ===== 飞凡AI - 主入口 (v2.7.0 功能大合集) ===== */
/* 工作流 + 文件夹/日期分组/拖拽 + 模式锁定 + 钉钉报警
   + 多协议(OpenAI/Anthropic/Gemini) + Prompt缓存 + token/费用统计 + 多Key轮询 */
/* 美元转人民币预估汇率（美元为准，人民币仅供预估） */
const USD_TO_CNY = 6.8;
let S = {
    profiles: {}, chats: {}, chatOrder: [], currentChatId: null,
    currentEngId: 'claude', theme: 'light', snapInterval: 5,
    userName: '', archiveInterval: 10, uiMode: 'chat',
    defaultMode: 'free', folders: [], folderCollapsed: {},
};

let _saveTimer=null,_saveInProgress=null,_streamCtrl=null,_pendingAtts=[],_attContinuous=false,_exportMode='full';
let _wfGroup='__all__',_wfPresetId=null;
var _wfAlertCtx=null;
let _dragChatId=null;

const MODE_SUFFIX={free:'-自由',workflow:'-工作流'};
function modeLabel(m){return m==='workflow'?'工作流':'自由';}

function buildTitleWithSuffix(rawTitle,mode){
    let t=(rawTitle||'').trim()||'新对话';
    t=t.replace(/-自由$/,'').replace(/-工作流$/,'').trim()||'新对话';
    const suf=MODE_SUFFIX[mode]||MODE_SUFFIX.free;
    return t+suf;
}

/* ===== 持久化 ===== */
function scheduleSave(){ if(_saveTimer)clearTimeout(_saveTimer); _saveTimer=setTimeout(saveNow,300); }
async function saveNow(){ if(_saveInProgress){await _saveInProgress;return;} _saveInProgress=DB.saveState(S); try{await _saveInProgress;}finally{_saveInProgress=null;} }

async function loadState(){
    const loaded=await DB.loadState();
    if(loaded&&typeof loaded==='object'){
        S=Object.assign({profiles:{},chats:{},chatOrder:[],currentChatId:null,currentEngId:'claude',theme:'light',snapInterval:5,userName:'',archiveInterval:10,uiMode:'chat',defaultMode:'free',folders:[],folderCollapsed:{}},loaded);
        if(!Array.isArray(S.folders))S.folders=[];
        if(!S.folderCollapsed||typeof S.folderCollapsed!=='object')S.folderCollapsed={};
        if(!S.defaultMode)S.defaultMode='free';
        if(!S.chatOrder||!S.chatOrder.length) S.chatOrder=Object.keys(S.chats||{}).sort((a,b)=>(S.chats[b].updatedAt||0)-(S.chats[a].updatedAt||0));
        for(const cid in S.chats){const c=S.chats[cid];if(c.messages)c.messages.forEach(m=>{if(m._streaming){m._streaming=false;m._interrupted=true;}});}
    }
    if(!S.profiles||!Object.keys(S.profiles).length) S.profiles=JSON.parse(JSON.stringify(API.DEFAULT_PROFILES));
    fixProfileFields();
    if(!S.profiles[S.currentEngId]) S.currentEngId=Object.keys(S.profiles)[0]||'claude';
    if(S.theme==='dark'){document.documentElement.setAttribute('data-theme','dark');const tb=document.getElementById('themeBtn');if(tb)tb.textContent='☀️';}
}

/* 补齐所有引擎字段（多协议 + 缓存 + 价格），老数据/导入数据都安全 */
function fixProfileFields(){
    for(const id in S.profiles){const p=S.profiles[id];
        if(p.useTemp===undefined)p.useTemp=true;if(p.useMax===undefined)p.useMax=true;
        if(p.useTopP===undefined)p.useTopP=false;if(p.useFreq===undefined)p.useFreq=false;
        if(p.temperature===undefined)p.temperature=0.7;if(p.max_tokens===undefined)p.max_tokens=4096;
        if(p.top_p===undefined)p.top_p=1;if(p.frequency_penalty===undefined)p.frequency_penalty=0;
        if(p.protocol===undefined)p.protocol='openai';
        if(p.engineType===undefined)p.engineType='chat';        
        p.authType='bearer';
        if(p.useCache===undefined)p.useCache=false;
        p.cacheTTL=(p.protocol==='anthropic')?'1h':'5m';
        if(p.priceIn===undefined)p.priceIn=0;
        if(p.priceOut===undefined)p.priceOut=0;
        if(p.priceCacheRead===undefined)p.priceCacheRead=0;
        if(p.priceCacheWrite===undefined)p.priceCacheWrite=0;
    }
}

function curChat(){ return S.currentChatId?(S.chats[S.currentChatId]||null):null; }
function curProfile(){ return S.profiles[S.currentEngId]||S.profiles[Object.keys(S.profiles)[0]]; }
function chatMode(c){ if(!c)return S.defaultMode||'free'; return c.mode||'free'; }
function isModeLocked(c){ return !!(c&&c.modeLocked); }

/* ===== 会话管理 ===== */
function newChat(){
    const id=gId();
    const mode=(S.defaultMode==='workflow')?'workflow':'free';
    S.chats[id]={id:id,title:buildTitleWithSuffix('新对话',mode),messages:[],systemPrompt:'',knowledgeBase:[],isPinned:false,isArchived:false,createdAt:Date.now(),updatedAt:Date.now(),mode:mode,modeLocked:false,folderId:null};
    S.chatOrder.unshift(id);S.currentChatId=id;
    S.uiMode=(mode==='workflow')?'workflow':'chat';
    scheduleSave();renderAll();
    if(IS_MOBILE){document.getElementById('sb').classList.remove('open');document.getElementById('sbOv').classList.remove('show');}
}
function switchChat(id){
    if(!S.chats[id])return;S.currentChatId=id;
    const c=S.chats[id];
    S.uiMode=(chatMode(c)==='workflow')?'workflow':'chat';
    scheduleSave();renderAll();
    if(IS_MOBILE){document.getElementById('sb').classList.remove('open');document.getElementById('sbOv').classList.remove('show');}
}
function delChat(id){if(!confirm('确认删除此对话？'))return;delete S.chats[id];S.chatOrder=S.chatOrder.filter(x=>x!==id);if(S.currentChatId===id)S.currentChatId=S.chatOrder[0]||null;scheduleSave();renderAll();}
function renameChat(id){
    const c=S.chats[id];if(!c)return;
    const bare=(c.title||'').replace(/-自由$/,'').replace(/-工作流$/,'').trim();
    const nv=prompt('重命名对话（系统会自动加模式后缀）：',bare);
    if(nv!==null){c.title=buildTitleWithSuffix(nv,chatMode(c));c.updatedAt=Date.now();scheduleSave();renderAll();}
}
function updTitle(v){const c=curChat();if(!c)return;c.title=buildTitleWithSuffix(v,chatMode(c));c.updatedAt=Date.now();scheduleSave();
    const ti=document.getElementById('titleIn');if(ti)ti.value=c.title;renderSB();}
function pinC(){const c=curChat();if(!c)return;c.isPinned=!c.isPinned;c.updatedAt=Date.now();scheduleSave();renderAll();toast(c.isPinned?'已置顶':'已取消置顶');}
function arcC(){const c=curChat();if(!c)return;c.isArchived=!c.isArchived;c.updatedAt=Date.now();scheduleSave();renderAll();toast(c.isArchived?'已归档':'已取消归档');}
function clrC(){const c=curChat();if(!c)return;if(!confirm('清空当前对话所有消息？'))return;c.messages=[];c.updatedAt=Date.now();scheduleSave();renderMs();}

async function shareC(){
    const c=curChat();if(!c){toast('请先选择一个对话','er');return;}
    if(!c.messages||!c.messages.length){toast('对话为空，无法分享','er');return;}
    const includeKB=(c.knowledgeBase&&c.knowledgeBase.length>0)?confirm('是否包含知识库文件？\n\n✅ 确定 = 包含\n❌ 取消 = 不包含'):false;
    let password='';
    if(Snapshot.SUPPORTS_CRYPTO){
        const wantPwd=confirm('是否设置访问口令？\n\n✅ 确定 = 设口令\n❌ 取消 = 不设（仅飞凡AI用户可打开）');
        if(wantPwd){const pwd=prompt('请输入访问口令：','');if(pwd&&pwd.trim())password=pwd.trim();else toast('未输入口令，仅用应用密钥加密');}
    }
    await Snapshot.shareChat(c,{includeKB:includeKB,sharedBy:S.userName||'',encrypt:true,password:password});
}

function togTheme(){S.theme=S.theme==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',S.theme==='dark'?'dark':'');document.getElementById('themeBtn').textContent=S.theme==='dark'?'☀️':'🌙';scheduleSave();}
function updUserName(v){S.userName=(v||'').trim();scheduleSave();}
function updDefaultMode(v){S.defaultMode=(v==='workflow')?'workflow':'free';scheduleSave();toast('默认新建模式：'+modeLabel(S.defaultMode));}

/* ===== 安全：报警 + 敏感词拦截（工作流） ===== */
function fireAlert(text){ if(typeof Workflow!=='undefined') Workflow.sendAlert(text); }
function guardSensitive(inputText, sceneInfo){
    if(typeof Workflow==='undefined') return false;
    const hit=Workflow.checkSensitive(inputText);
    if(hit){
        const c=curChat();
        fireAlert('⚠️ 敏感词拦截\n用户：'+(S.userName||'未署名')
            +'\n对话：《'+((c&&c.title)||'未命名')+'》'
            +'\n场景：'+(sceneInfo||'工作流')
            +'\n命中敏感词：'+hit
            +'\n完整输入：'+inputText
            +'\n时间：'+new Date().toLocaleString());
        toast('⚠️ 输入包含受限内容，已阻止发送','er');
        return true;
    }
    return false;
}

/* ===== 模式切换（对话级 + 锁定） ===== */
function setMode(mode){
    const target=(mode==='workflow')?'workflow':'free';
    const c=curChat();
    if(!c){S.uiMode=(target==='workflow')?'workflow':'chat';renderMode();return;}
    const cur=chatMode(c);
    if(cur===target){S.uiMode=(target==='workflow')?'workflow':'chat';renderMode();return;}
    if(isModeLocked(c)){toast('该对话已锁定为「'+modeLabel(cur)+'」模式，请新开对话切换','er');S.uiMode=(cur==='workflow')?'workflow':'chat';renderMode();return;}
    if(!confirm('确定将本对话切换为「'+modeLabel(target)+'」模式？\n\n发送第一条消息后将永久锁定，无法再改。')){S.uiMode=(cur==='workflow')?'workflow':'chat';renderMode();return;}
    c.mode=target;c.title=buildTitleWithSuffix(c.title,target);c.updatedAt=Date.now();
    S.uiMode=(target==='workflow')?'workflow':'chat';
    scheduleSave();renderAll();
    toast('已切换为「'+modeLabel(target)+'」模式');
}
function renderMode(){
    const c=curChat();
    const isWf=(chatMode(c)==='workflow');
    S.uiMode=isWf?'workflow':'chat';
    const wfBar=document.getElementById('wfBar');
    if(wfBar)wfBar.classList.toggle('show',isWf);
    const cb=document.getElementById('modeChatBtn'),wb=document.getElementById('modeWfBtn');
    if(cb)cb.classList.toggle('act',!isWf);if(wb)wb.classList.toggle('act',isWf);
    const locked=isModeLocked(c);
    [cb,wb].forEach(btn=>{if(!btn)return;btn.classList.toggle('locked',locked);});
    if(isWf)renderWorkflow();
}
function renderWorkflow(){
    if(typeof Workflow==='undefined'||!Workflow.isLoaded()){
        const box=document.getElementById('wfCmds');if(box)box.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">⚠️ 预设库未加载（presets.json）</div>';return;
    }
    const grpSel=document.getElementById('wfGroupSel');
    if(grpSel&&!grpSel.dataset.filled){
        const groups=Workflow.getGroups();
        grpSel.innerHTML='<option value="__all__">全部分组</option>'+groups.map(g=>'<option value="'+esc(g)+'">'+esc(g)+'</option>').join('');
        grpSel.dataset.filled='1';
    }
    const kw=(document.getElementById('wfSearch')?document.getElementById('wfSearch').value:'')||'';
    const presets=Workflow.getPresets(_wfGroup,kw);
    const psSel=document.getElementById('wfPresetSel');
    if(psSel){
        psSel.innerHTML=presets.length?presets.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'（'+esc(p.group||'')+'）</option>').join(''):'<option value="">（无匹配预设）</option>';
        if(_wfPresetId&&presets.some(p=>p.id===_wfPresetId))psSel.value=_wfPresetId;
        else{_wfPresetId=presets.length?presets[0].id:null;if(_wfPresetId)psSel.value=_wfPresetId;}
    }
    renderWfSteps();
}
function onWfGroupChange(v){_wfGroup=v||'__all__';_wfPresetId=null;renderWorkflow();}
function onWfSearch(){renderWorkflow();}
function onWfPresetChange(v){_wfPresetId=v||null;renderWfSteps();}

function renderWfSteps(){
    const box=document.getElementById('wfCmds');if(!box)return;
    if(!_wfPresetId){box.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">请选择一个预设</div>';return;}
    const steps=Workflow.getSteps(_wfPresetId);
    if(!steps.length){box.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">该预设暂无步骤</div>';return;}
    box.innerHTML='';
    steps.forEach((s,i)=>{
        const inputs=Workflow.getInputs(_wfPresetId,s.id);
        const wrap=document.createElement('div');wrap.className='wf-cmd';
        let html='<div class="wf-cmd-title">'+(i+1)+'. '+esc(s.name)+'</div>';
        if(inputs.length){
            inputs.forEach(inp=>{
                if(inp.kind==='blank'){
                    let row='<div class="wf-blank" data-seg="'+inp.segIndex+'">';
                    let bIdx=0;
                    inp.parts.forEach(part=>{
                        if(part.blank){row+='<span class="wf-blank-in" contenteditable="true" data-bi="'+bIdx+'" data-ph="填写"></span>';bIdx++;}
                        else{row+='<span class="wf-blank-txt">'+esc(part.text)+'</span>';}
                    });
                    row+='</div>';html+=row;
                }else{
                    html+='<textarea class="wf-cmd-input" data-seg="'+inp.segIndex+'" data-kind="input" id="wfin_'+esc(s.id)+'_'+inp.segIndex+'" rows="3" placeholder="'+esc(inp.placeholder)+'">'+esc(inp.defaultValue||'')+'</textarea>';
                }
            });
        }else{html+='<div style="font-size:12px;color:var(--text2);margin-bottom:6px">（此步骤无需输入，直接发送）</div>';}
        html+='<button class="btn btn-p btn-s wf-cmd-send" onclick="wfSend(\''+esc(s.id)+'\')">▶ 用此步骤发送</button>';
        wrap.innerHTML=html;box.appendChild(wrap);
    });
}

async function wfSend(stepId){
    const c=curChat();
    if(c&&chatMode(c)!=='workflow'){toast('当前对话不是工作流模式','er');return;}
    if(!_wfPresetId){toast('请先选择预设','er');return;}
    if(_streamCtrl){toast('请等待当前回复完成','er');return;}
    const inputsMap={};let joinedInput='';
    const stepEl=event&&event.target?event.target.closest('.wf-cmd'):null;
    const scope=stepEl||document;
    scope.querySelectorAll('textarea[data-kind="input"][id^="wfin_'+stepId+'_"]').forEach(el=>{
        const seg=parseInt(el.getAttribute('data-seg'),10);
        inputsMap[seg]=el.value;
        if(el.value&&el.value.trim())joinedInput+=' '+el.value.trim();
    });
    let blankMissing=false;
    scope.querySelectorAll('.wf-blank').forEach(bl=>{
        const seg=parseInt(bl.getAttribute('data-seg'),10);
        const vals=[];
        bl.querySelectorAll('.wf-blank-in').forEach(inEl=>{
            const v=(inEl.textContent||'').trim();
            vals.push(v);if(!v)blankMissing=true;if(v)joinedInput+=' '+v;
        });
        inputsMap[seg]=vals;
    });
    if(blankMissing){toast('请填写所有空位后再发送','er');return;}
    const presetName=Workflow.getPresetName(_wfPresetId);
    if(guardSensitive(joinedInput.trim(),'工作流·预设《'+presetName+'》'))return;
    let built;
    try{built=await Workflow.buildSend(_wfPresetId,stepId,inputsMap);}
    catch(e){toast('指令解密失败：'+e.message,'er');return;}
    if(built.missing&&built.missing.length){toast('请填写所有空位后再发送','er');return;}
    _wfAlertCtx={user:S.userName||'未署名',preset:presetName,step:built.stepName,input:joinedInput.trim()};
    await coreSend({visibleText:built.displayText,actualText:built.sendText,titleHint:built.stepName,_wfLeakCheck:true});
    const inputs=Workflow.getInputs(_wfPresetId,stepId);
    inputs.forEach(inp=>{
        if(inp.kind==='input'){const el=document.getElementById('wfin_'+stepId+'_'+inp.segIndex);if(el)el.value=inp.defaultValue||'';}
    });
    scope.querySelectorAll('.wf-blank-in').forEach(inEl=>{inEl.textContent='';});
}

/* ===== 文件夹管理 ===== */
function addFolder(){
    const name=prompt('新建文件夹名称：','新文件夹');
    if(!name||!name.trim())return;
    const id='fd_'+gId().slice(0,8);
    S.folders.push({id:id,name:name.trim()});
    scheduleSave();renderSB();
}
function renameFolder(fid){
    const f=S.folders.find(x=>x.id===fid);if(!f)return;
    const nv=prompt('重命名文件夹：',f.name);
    if(nv&&nv.trim()){f.name=nv.trim();scheduleSave();renderSB();}
}
function delFolder(fid){
    const f=S.folders.find(x=>x.id===fid);if(!f)return;
    if(!confirm('删除文件夹「'+f.name+'」？\n\n文件夹内的对话不会被删除，会移回未分类。'))return;
    for(const cid in S.chats){if(S.chats[cid].folderId===fid)S.chats[cid].folderId=null;}
    S.folders=S.folders.filter(x=>x.id!==fid);
    delete S.folderCollapsed[fid];
    scheduleSave();renderSB();
}
function toggleFolder(fid){S.folderCollapsed[fid]=!S.folderCollapsed[fid];scheduleSave();renderSB();}
function moveChatToFolder(cid,fid){const c=S.chats[cid];if(!c)return;c.folderId=fid||null;c.updatedAt=Date.now();scheduleSave();renderSB();}

function dateGroupOf(ts){
    if(!ts)return '更早';
    const now=new Date();
    const startToday=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
    const startYest=startToday-86400000;
    const day=now.getDay()||7;
    const startWeek=startToday-(day-1)*86400000;
    if(ts>=startToday)return '今天';
    if(ts>=startYest)return '昨天';
    if(ts>=startWeek)return '本周';
    return '更早';
}

/* ===== 侧边栏（文件夹 + 日期分组 + 搜索 + 拖拽） ===== */
function _makeChatLi(id){
    const c=S.chats[id];
    const li=document.createElement('li');
    li.className='ci'+(id===S.currentChatId?' act':'');
    li.draggable=true;li.dataset.cid=id;
    li.onclick=()=>switchChat(id);
    li.ondragstart=(e)=>{_dragChatId=id;li.classList.add('dragging');try{e.dataTransfer.setData('text/plain',id);e.dataTransfer.effectAllowed='move';}catch(err){}};
    li.ondragend=()=>{_dragChatId=null;li.classList.remove('dragging');};
    const span=document.createElement('span');span.className='ct';span.textContent=c.title||'新对话';li.appendChild(span);
    const acts=document.createElement('div');acts.className='ia';
    const rb=document.createElement('button');rb.textContent='✏️';rb.title='重命名';rb.onclick=(e)=>{e.stopPropagation();renameChat(id);};
    const db=document.createElement('button');db.textContent='🗑️';db.title='删除';db.onclick=(e)=>{e.stopPropagation();delChat(id);};
    acts.appendChild(rb);acts.appendChild(db);li.appendChild(acts);
    return li;
}

function renderSB(){
    const search=(document.getElementById('schIn').value||'').toLowerCase();
    const pinList=document.getElementById('pinList'),chatList=document.getElementById('chatList'),arcList=document.getElementById('arcList'),folderArea=document.getElementById('folderArea');
    pinList.innerHTML='';chatList.innerHTML='';arcList.innerHTML='';if(folderArea)folderArea.innerHTML='';

    const order=S.chatOrder.filter(id=>S.chats[id]);
    function match(c){
        if(!search)return true;
        const hay=(c.title+' '+(c.messages||[]).map(m=>typeof m.content==='string'?m.content:'').join(' ')).toLowerCase();
        return hay.includes(search);
    }

    if(search){
        if(folderArea)folderArea.style.display='none';
        document.getElementById('pinLbl').style.display='none';
        document.getElementById('arcLbl').style.display='none';
        let n=0;
        order.forEach(id=>{const c=S.chats[id];if(!match(c))return;chatList.appendChild(_makeChatLi(id));n++;});
        if(!n)chatList.innerHTML='<li style="font-size:12px;color:var(--text2);padding:8px">无匹配对话</li>';
        renderBadge();return;
    }

    if(folderArea)folderArea.style.display='';
    let pinCount=0,arcCount=0;

    order.forEach(id=>{const c=S.chats[id];if(c.isArchived||!c.isPinned)return;pinList.appendChild(_makeChatLi(id));pinCount++;});

    if(folderArea){
        S.folders.forEach(f=>{
            const collapsed=!!S.folderCollapsed[f.id];
            const fEl=document.createElement('div');fEl.className='folder'+(collapsed?' collapsed':'');
            fEl.dataset.fid=f.id;
            fEl.ondragover=(e)=>{e.preventDefault();e.dataTransfer.dropEffect='move';fEl.classList.add('drop-hover');};
            fEl.ondragleave=()=>fEl.classList.remove('drop-hover');
            fEl.ondrop=(e)=>{e.preventDefault();fEl.classList.remove('drop-hover');const cid=_dragChatId||e.dataTransfer.getData('text/plain');if(cid)moveChatToFolder(cid,f.id);};
            const hdr=document.createElement('div');hdr.className='folder-hdr';
            const childCount=order.filter(id=>S.chats[id].folderId===f.id&&!S.chats[id].isArchived&&!S.chats[id].isPinned).length;
            hdr.innerHTML='<span class="fd-tog">'+(collapsed?'▶':'▼')+'</span><span class="fd-name">📁 '+esc(f.name)+'</span><span class="fd-cnt">'+childCount+'</span>';
            hdr.onclick=()=>toggleFolder(f.id);
            const fActs=document.createElement('div');fActs.className='fd-acts';
            const fr=document.createElement('button');fr.textContent='✏️';fr.title='重命名文件夹';fr.onclick=(e)=>{e.stopPropagation();renameFolder(f.id);};
            const fdd=document.createElement('button');fdd.textContent='🗑️';fdd.title='删除文件夹';fdd.onclick=(e)=>{e.stopPropagation();delFolder(f.id);};
            fActs.appendChild(fr);fActs.appendChild(fdd);hdr.appendChild(fActs);
            fEl.appendChild(hdr);
            const ul=document.createElement('ul');ul.className='cl folder-cl';
            if(!collapsed){order.forEach(id=>{const c=S.chats[id];if(c.isArchived||c.isPinned||c.folderId!==f.id)return;ul.appendChild(_makeChatLi(id));});}
            fEl.appendChild(ul);
            folderArea.appendChild(fEl);
        });
    }

    const ungrouped=order.filter(id=>{const c=S.chats[id];return !c.isArchived&&!c.isPinned&&!c.folderId;});
    const groups={'今天':[],'昨天':[],'本周':[],'更早':[]};
    ungrouped.forEach(id=>{groups[dateGroupOf(S.chats[id].updatedAt)].push(id);});
    chatList.classList.add('with-dategroup');
    ['今天','昨天','本周','更早'].forEach(g=>{
        if(!groups[g].length)return;
        const key='dg_'+g;
        const collapsed=!!S.folderCollapsed[key];
        const lbl=document.createElement('div');lbl.className='dg-lbl';
        lbl.innerHTML='<span>'+(collapsed?'▶':'▼')+' '+g+'</span><span class="fd-cnt">'+groups[g].length+'</span>';
        lbl.onclick=()=>{S.folderCollapsed[key]=!S.folderCollapsed[key];scheduleSave();renderSB();};
        chatList.appendChild(lbl);
        if(!collapsed)groups[g].forEach(id=>chatList.appendChild(_makeChatLi(id)));
    });
    chatList.ondragover=(e)=>{e.preventDefault();e.dataTransfer.dropEffect='move';};
    chatList.ondrop=(e)=>{e.preventDefault();const cid=_dragChatId||e.dataTransfer.getData('text/plain');if(cid&&S.chats[cid]&&S.chats[cid].folderId){moveChatToFolder(cid,null);}};

    order.forEach(id=>{const c=S.chats[id];if(!c.isArchived)return;arcList.appendChild(_makeChatLi(id));arcCount++;});

    document.getElementById('pinLbl').style.display=pinCount?'block':'none';
    document.getElementById('arcLbl').style.display=arcCount?'block':'none';
    renderBadge();
}
function renderBadge(){
    const p=curProfile();
    const isImg=p&&p.engineType==='image';
    const protoTag=p?(isImg?' [🎨生图]':p.protocol==='anthropic'?' [Claude原生]':p.protocol==='gemini'?' [Gemini原生]':''):'';
    const cacheTag=(p&&p.useCache&&!isImg)?' 💰缓存':'';
    document.getElementById('badge').innerHTML=p?'当前引擎: <strong>'+esc(p.name)+'</strong>'+esc(protoTag)+esc(cacheTag)+'<br>模型: '+esc(p.model||'-'):'请先在 ⚙️ 中配置引擎';
}


/* ===== 渲染消息区 + token/费用信息 ===== */
function renderMs(){
    const area=document.getElementById('msgsArea');const c=curChat();
    if(!c){area.innerHTML='<div class="empty"><div class="ico">🚀</div><p>请先新建一个对话</p></div>';return;}
    UI.renderMessages(area,c.messages,{
        onDelete:(m)=>{c.messages=c.messages.filter(x=>x!==m);c.updatedAt=Date.now();scheduleSave();renderMs();},
        onRegen:(m)=>regenerate(m),
    });
    appendUsageInfo(area,c);
    const ti=document.getElementById('titleIn');if(ti)ti.value=c.title||'';
    document.getElementById('pinBtn').textContent=c.isPinned?'📍':'📌';
    renderChatTotal(c);   // ★ 新增
}

/* ===== 标题栏右侧显示本对话累计花费 ===== */
function renderChatTotal(chat){
    let el=document.getElementById('chatTotalTag');
    if(!el){
        const acts=document.querySelector('.hdr-acts');
        if(!acts)return;
        el=document.createElement('span');
        el.id='chatTotalTag';
        el.style.cssText='font-size:11px;color:var(--text2);margin-right:8px;white-space:nowrap;align-self:center';
        acts.parentNode.insertBefore(el,acts);
    }
    const t=calcChatTotal(chat);
    if(!t.hasUsage){el.textContent='';el.title='';return;}
    let txt='本对话 Σ'+t.totalTokens.toLocaleString();
    if(t.hasCost&&t.cost>0)txt+=' ≈$'+t.cost.toFixed(4)+'(¥'+(t.cost*USD_TO_CNY).toFixed(2)+')';
    el.textContent='💰 '+txt;
    el.title='本对话累计：入'+t.inputTokens+' 出'+t.outputTokens
        +(t.cacheReadTokens?' 缓存命中'+t.cacheReadTokens:'')
        +(t.cacheWriteTokens?' 缓存写入'+t.cacheWriteTokens:'')
        +(t.hasCost?'\n估算总花费 ≈$'+t.cost.toFixed(4)+' ≈¥'+(t.cost*USD_TO_CNY).toFixed(4)+'（汇率'+USD_TO_CNY+'预估）':'\n（未填单价，仅统计token）');
}
function appendUsageInfo(area,chat){
    const nodes=area.querySelectorAll('.msg.assistant');
    let idx=0;
    const aiMsgs=(chat.messages||[]).filter(m=>m.role==='assistant');
    nodes.forEach(node=>{
        const m=aiMsgs[idx++];
        if(!m||!m._usage)return;
        const mm=node.querySelector('.mm');
        if(!mm||mm.querySelector('.usage-tag'))return;
        const tag=document.createElement('span');
        tag.className='usage-tag';
        tag.style.cssText='font-size:10px;color:var(--text2);opacity:.85';
        tag.innerHTML=formatUsage(m._usage,m._engId);
        mm.appendChild(tag);
    });
}
function formatUsage(u,engId){
    if(!u)return '';
    const input=u.inputTokens||0,output=u.outputTokens||0,total=input+output;
    const cacheRead=u.cacheReadTokens||0,cacheWrite=u.cacheWriteTokens||0;
    const parts=[];
    parts.push('⬆入'+input);parts.push('⬇出'+output);parts.push('Σ总'+total);
    if(cacheRead)parts.push('💰命中'+cacheRead);
    if(cacheWrite)parts.push('✍写'+cacheWrite);
    let costStr='';
    const cost=calcMsgCost(u,engId);
    if(cost!=null&&cost>0){
        costStr=' ≈$'+cost.toFixed(4)+' (¥'+(cost*USD_TO_CNY).toFixed(4)+')';
    }
    return ' | '+parts.join(' ')+costStr;
}
/* ===== 单条费用计算（按协议区分缓存；优先用平台返回费用） ===== */
function calcMsgCost(u,engId){
    if(!u)return null;
    // 平台直接返回了费用 → 最准，优先用
    if(u.platformCost!=null)return u.platformCost;
    const p=engId?S.profiles[engId]:null;
    if(!p||!(p.priceIn||p.priceOut||p.priceCacheRead||p.priceCacheWrite))return null;
    const input=u.inputTokens||0,output=u.outputTokens||0;
    const cacheRead=u.cacheReadTokens||0,cacheWrite=u.cacheWriteTokens||0;
    let inputCost;
    if((u.mode||p.protocol||'openai')==='openai'){
        // OpenAI 协议：prompt_tokens 已含 cached，需减出去单独按缓存价算
        inputCost=Math.max(0,input-cacheRead-cacheWrite)/1e6*(p.priceIn||0);
    }else{
        // Anthropic / Gemini：input 本身不含缓存，直接全价
        inputCost=input/1e6*(p.priceIn||0);
    }
    return inputCost
        + output/1e6*(p.priceOut||0)
        + cacheRead/1e6*(p.priceCacheRead||0)
        + cacheWrite/1e6*(p.priceCacheWrite||0);
}

/* ===== 整段对话累计花费（token + 金额） ===== */
function calcChatTotal(chat){
    const r={inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:0,cost:0,hasCost:false,hasUsage:false};
    if(!chat||!chat.messages)return r;
    chat.messages.forEach(m=>{
        if(m.role!=='assistant'||!m._usage)return;
        const u=m._usage;
        r.hasUsage=true;
        r.inputTokens+=u.inputTokens||0;
        r.outputTokens+=u.outputTokens||0;
        r.cacheReadTokens+=u.cacheReadTokens||0;
        r.cacheWriteTokens+=u.cacheWriteTokens||0;
        const c=calcMsgCost(u,m._engId);
        if(c!=null){r.cost+=c;r.hasCost=true;}
    });
    r.totalTokens=r.inputTokens+r.outputTokens+r.cacheReadTokens+r.cacheWriteTokens;
    return r;
}
function renderAll(){renderSB();renderMs();renderEngTabs();renderEngForm();renderCSForm();renderStorageInfo();renderArchiveInfo();renderMode();}

/* ===== 引擎配置（多协议 + 缓存 + 价格 + 多Key） ===== */
function renderEngTabs(){
    const tabs=document.getElementById('engTabs');if(!tabs)return;tabs.innerHTML='';
    Object.values(S.profiles).forEach(p=>{
        const b=document.createElement('button');b.className='tab'+(p.id===S.currentEngId?' act':'');b.textContent=p.name;
        b.onclick=()=>{S.currentEngId=p.id;renderEngTabs();renderEngForm();renderSB();renderMs();scheduleSave();toast('已切换到：'+p.name);};
        tabs.appendChild(b);
    });
}
const MAX_TOKEN_PRESETS=[{label:'4K',val:4096},{label:'8K',val:8192},{label:'16K',val:16384},{label:'32K',val:32768},{label:'64K',val:65536},{label:'128K',val:131072},{label:'256K',val:262144},{label:'1M',val:1048576}];

function renderEngForm(){
    const form=document.getElementById('engForm');if(!form)return;
    const p=S.profiles[S.currentEngId];if(!p){form.innerHTML='<p style="color:var(--text2)">请选择一个引擎</p>';return;}
    form.innerHTML=`
        <div class="fg"><label>引擎名称</label><input type="text" id="engName" value="${esc(p.name)}"></div>
        <div class="fg"><label>🔧 引擎类型</label><select id="engType" onchange="onEngTypeChange()">
            <option value="chat"${p.engineType!=='image'?' selected':''}>💬 对话</option>
            <option value="image"${p.engineType==='image'?' selected':''}>🎨 生图</option>
        </select><div style="font-size:11px;color:var(--text2);margin-top:4px">生图引擎：切到它后，输入框打描述即生成图片（模型如 openai/gpt-image-2，手动填）</div></div>
        <div class="fg"${p.engineType==='image'?' style="display:none"':''} id="engProtoBox"><label>📡 协议类型</label><select id="engProto">
            <option value="openai"${p.protocol==='openai'?' selected':''}>OpenAI / 通用</option>
            <option value="anthropic"${p.protocol==='anthropic'?' selected':''}>Claude 原生（用claude的必选）</option>
            <option value="gemini"${p.protocol==='gemini'?' selected':''}>Gemini 原生</option>
        </select></div>
        <div class="fg"><label>🌐 Base URL</label><input type="text" id="engBase" value="${esc(p.base)}" placeholder="https://api.openai-proxy.org/v1">
            <div style="font-size:11px;color:var(--text2);margin-top:4px">OpenAI兼容→ 填带 /v1 的地址；Claude→ 填 .../anthropic；Gemini→ 填 .../google</div></div>
        <div class="fg"><label>🔑 API Key <span style="font-weight:normal;color:var(--text2);font-size:11px">（仅本地存储，不显示）</span></label>
            <input type="password" id="engKey" value="${esc(p.key)}" autocomplete="off" placeholder="sk-..."></div>
        <div class="fg"><label>🧠 模型 ID</label><div style="display:flex;gap:6px"><input type="text" id="engModel" value="${esc(p.model)}" placeholder="claude-opus-4-8" style="flex:1"><button class="btn btn-s" onclick="fMdls()" id="fMdlsBtn" style="white-space:nowrap">🔄 获取</button></div><div id="mdlSel" style="display:none;margin-top:6px"></div></div>
        <div style="margin-top:14px;padding:12px;background:var(--pri-l);border-radius:10px">
            <div class="pt"><input type="checkbox" id="engUseCache" ${p.useCache?'checked':''}><label for="engUseCache">💰 开启 Prompt 缓存（省 token）</label></div>
            <div id="engCacheBox" style="${p.useCache?'':'display:none'};padding-left:23px;margin-top:6px">
                <div style="font-size:11px;color:var(--text2);line-height:1.6">给 System Prompt + 历史对话打缓存标记自动省钱。<br>缓存仅影响计费，不影响发送内容（每轮始终发全量对话）。</div>
            </div>
        </div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)"><h4 style="font-size:13px;margin-bottom:10px">⚙️ 运行时参数</h4>
            <div class="pt"><input type="checkbox" id="engUseTemp" ${p.useTemp?'checked':''}><label for="engUseTemp">🔥 Temperature 温度</label></div>
            <div class="ps" id="engTempBox" style="${p.useTemp?'':'display:none'}"><input type="range" id="engTemp" min="0" max="2" step="0.1" value="${p.temperature}"><div>当前值：<span class="pv" id="engTempV">${p.temperature}</span><span style="font-size:11px;color:var(--text2);margin-left:8px">0=精确, 2=发散</span></div></div>
            <div class="pt"><input type="checkbox" id="engUseMax" ${p.useMax?'checked':''}><label for="engUseMax">📏 Max Tokens 最大输出长度</label></div>
            <div class="ps" id="engMaxBox" style="${p.useMax?'':'display:none'}"><input type="number" id="engMax" value="${p.max_tokens}" min="1" max="2097152"><div class="presets">${MAX_TOKEN_PRESETS.map(x=>`<button onclick="setMax(${x.val})">${x.label}</button>`).join('')}</div></div>
            <div class="pt"><input type="checkbox" id="engUseTopP" ${p.useTopP?'checked':''}><label for="engUseTopP">🎲 Top P 核采样</label></div>
            <div class="ps" id="engTopPBox" style="${p.useTopP?'':'display:none'}"><input type="range" id="engTopP" min="0" max="1" step="0.05" value="${p.top_p}"><div>当前值：<span class="pv" id="engTopPV">${p.top_p}</span></div></div>
            <div class="pt"><input type="checkbox" id="engUseFreq" ${p.useFreq?'checked':''}><label for="engUseFreq">🚫 Frequency Penalty 重复惩罚（Gemini不支持）</label></div>
            <div class="ps" id="engFreqBox" style="${p.useFreq?'':'display:none'}"><input type="range" id="engFreq" min="-2" max="2" step="0.1" value="${p.frequency_penalty}"><div>当前值：<span class="pv" id="engFreqV">${p.frequency_penalty}</span></div></div>
        </div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)"><h4 style="font-size:13px;margin-bottom:8px">💵 费用估算单价（美元 / 1M token，选填）</h4>
            <div class="fr"><div class="fg"><label>输入</label><input type="number" id="engPriceIn" value="${p.priceIn||0}" step="0.01" min="0"></div><div class="fg"><label>输出</label><input type="number" id="engPriceOut" value="${p.priceOut||0}" step="0.01" min="0"></div></div>
            <div class="fr"><div class="fg"><label>缓存命中(读)</label><input type="number" id="engPriceCR" value="${p.priceCacheRead||0}" step="0.01" min="0"></div><div class="fg"><label>缓存写入</label><input type="number" id="engPriceCW" value="${p.priceCacheWrite||0}" step="0.01" min="0"></div></div>
            <div style="font-size:11px;color:var(--text2)">填美元单价（如 Claude Opus 输入15、输出75、缓存命中1.5、缓存写入18.75）。下方费用会显示 $美元 + ¥人民币预估（汇率 ${USD_TO_CNY}）。不填则只显示 token 数。</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap"><button class="btn btn-p" onclick="saveEng()">💾 保存配置</button><button class="btn" onclick="tConn()" id="tConnBtn">🔑 测试连通</button>${API.DEFAULT_PROFILES[p.id]?'':'<button class="btn btn-d" onclick="delEng()">🗑️ 删除</button>'}</div>
    `;
    // 生图引擎隐藏缓存/运行时参数（生图不需要）
    if(p.engineType==='image'){
        const boxes=['engUseCache','engUseTemp','engUseMax','engUseTopP','engUseFreq'];
        // 隐藏整个运行时参数和缓存区块的父容器
        const cacheBlock=form.querySelector('#engUseCache');if(cacheBlock)cacheBlock.closest('div[style*="background"]').style.display='none';
    }
    bindEngEvents(p);

}

function bindEngEvents(p){
    const bind=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el[ev]=fn;};
    bind('engUseTemp','onchange',e=>document.getElementById('engTempBox').style.display=e.target.checked?'':'none');
    bind('engUseMax','onchange',e=>document.getElementById('engMaxBox').style.display=e.target.checked?'':'none');
    bind('engUseTopP','onchange',e=>document.getElementById('engTopPBox').style.display=e.target.checked?'':'none');
    bind('engUseFreq','onchange',e=>document.getElementById('engFreqBox').style.display=e.target.checked?'':'none');
    bind('engUseCache','onchange',e=>document.getElementById('engCacheBox').style.display=e.target.checked?'':'none');
    bind('engTemp','oninput',e=>document.getElementById('engTempV').textContent=e.target.value);
    bind('engTopP','oninput',e=>document.getElementById('engTopPV').textContent=e.target.value);
    bind('engFreq','oninput',e=>document.getElementById('engFreqV').textContent=e.target.value);
}

function setMax(val){document.getElementById('engMax').value=val;}
function onEngTypeChange(){
    const t=document.getElementById('engType').value;
    const p=S.profiles[S.currentEngId];if(!p)return;
    p.engineType=t;
    renderEngForm();
}

function saveEng(){
    const p=S.profiles[S.currentEngId];if(!p)return;
    p.name=document.getElementById('engName').value.trim()||p.name;
    // ★ 先存引擎类型
    const etEl=document.getElementById('engType');if(etEl)p.engineType=etEl.value;
    // ★ 协议下拉在生图模式下被隐藏，要防 null
    const protoEl=document.getElementById('engProto');if(protoEl)p.protocol=protoEl.value;
    p.base=document.getElementById('engBase').value.trim();
    p.key=document.getElementById('engKey').value.trim();
    p.model=document.getElementById('engModel').value.trim();
    // 生图引擎不需要这些运行时参数，但读取时防 null
    const g=(id)=>document.getElementById(id);
    if(g('engUseTemp')){p.useTemp=g('engUseTemp').checked;p.temperature=parseFloat(g('engTemp').value);}
    if(g('engUseMax')){p.useMax=g('engUseMax').checked;p.max_tokens=parseInt(g('engMax').value,10);}
    if(g('engUseTopP')){p.useTopP=g('engUseTopP').checked;p.top_p=parseFloat(g('engTopP').value);}
    if(g('engUseFreq')){p.useFreq=g('engUseFreq').checked;p.frequency_penalty=parseFloat(g('engFreq').value);}
    if(g('engUseCache')){p.useCache=g('engUseCache').checked;}
    p.cacheTTL=(p.protocol==='anthropic')?'1h':'5m';
    if(g('engPriceIn'))p.priceIn=parseFloat(g('engPriceIn').value)||0;
    if(g('engPriceOut'))p.priceOut=parseFloat(g('engPriceOut').value)||0;
    if(g('engPriceCR'))p.priceCacheRead=parseFloat(g('engPriceCR').value)||0;
    if(g('engPriceCW'))p.priceCacheWrite=parseFloat(g('engPriceCW').value)||0;
    scheduleSave();renderEngTabs();renderSB();renderMs();toast('✅ 配置已保存');
}

async function fMdls(){
    const p=S.profiles[S.currentEngId];if(!p)return;
    p.protocol=document.getElementById('engProto').value;
    
    p.base=document.getElementById('engBase').value.trim();p.key=document.getElementById('engKey').value.trim();
    if(!p.base||!p.key){toast('请先填写 Base URL 和 API Key','er');return;}
    const btn=document.getElementById('fMdlsBtn');btn.disabled=true;btn.textContent='⏳ 获取中...';
    try{
        const list=await API.fetchModels(p);if(!list.length){toast('未返回任何模型','er');return;}
        const sel=document.getElementById('mdlSel');sel.style.display='';
        sel.innerHTML='<select id="mdlPick" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">'+list.map(m=>'<option value="'+esc(m)+'"'+(m===p.model?' selected':'')+'>'+esc(m)+'</option>').join('')+'</select>';
        document.getElementById('mdlPick').onchange=(e)=>{document.getElementById('engModel').value=e.target.value;};
        toast('✅ 已获取 '+list.length+' 个模型');
    }catch(e){toast('获取失败：'+e.message,'er');}finally{btn.disabled=false;btn.textContent='🔄 获取';}
}

async function tConn(){
    const p=S.profiles[S.currentEngId];if(!p)return;
    p.protocol=document.getElementById('engProto').value;
    
    p.base=document.getElementById('engBase').value.trim();p.key=document.getElementById('engKey').value.trim();
    if(!p.base||!p.key){toast('请先填写 Base URL 和 API Key','er');return;}
    const btn=document.getElementById('tConnBtn');btn.disabled=true;btn.textContent='⏳ 测试中...';
    const r=await API.testConnection(p);btn.disabled=false;btn.textContent='🔑 测试连通';toast(r.msg,r.ok?'ok':'er');
}

function addEng(){
    const name=prompt('新引擎名称：','我的引擎');if(!name||!name.trim())return;
    const id='custom_'+gId().slice(0,8);
    S.profiles[id]={id:id,name:name.trim(),engineType:'chat',protocol:'openai',authType:'bearer',base:'https://api.openai-proxy.org/v1',key:'',model:'gpt-4o-mini',useTemp:true,temperature:0.7,useMax:true,max_tokens:4096,useTopP:false,top_p:1,useFreq:false,frequency_penalty:0,useCache:false,cacheTTL:'5m',priceIn:0,priceOut:0,priceCacheRead:0,priceCacheWrite:0};
    S.currentEngId=id;scheduleSave();renderEngTabs();renderEngForm();renderSB();renderMs();
}

function delEng(){
    const p=S.profiles[S.currentEngId];if(!p)return;
    if(API.DEFAULT_PROFILES[p.id]){toast('内置引擎不可删除','er');return;}
    if(!confirm('删除引擎 '+p.name+'？'))return;
    delete S.profiles[p.id];S.currentEngId=Object.keys(S.profiles)[0]||'claude';scheduleSave();renderEngTabs();renderEngForm();renderSB();renderMs();toast('已删除');
}

/* ===== 全局设置 ===== */
function renderGlobalSettings(){
    const uIn=document.getElementById('userNameIn');if(uIn)uIn.value=S.userName||'';
    const dm=document.getElementById('defaultModeSel');if(dm)dm.value=S.defaultMode||'free';
    const ai=document.getElementById('archiveIntervalSel');if(ai)ai.value=String(S.archiveInterval!==undefined?S.archiveInterval:10);
    renderArchiveInfo();
}
function renderArchiveInfo(){
    const el=document.getElementById('archiveInfo');if(!el||typeof Archive==='undefined')return;
    if(!Archive.isSupported()){el.innerHTML='<span style="color:var(--text2)">⚠️ 当前浏览器不支持自动存档（需 Chrome / Edge）</span>';return;}
    if(Archive.isEnabled()){
        const authTxt=Archive.isAuthorized()?'🟢 已授权':'🔴 待授权（刷新后点授权弹窗）';
        el.innerHTML='✅ 已开启自动存档（'+authTxt+'）<br>目录：<strong>'+esc(Archive.getDirName())+'</strong><br><span style="font-size:11px;color:var(--text2)">每 '+(S.archiveInterval||10)+' 分钟 + AI回复停笔1分钟后，自动保存有变动的对话（删除对话不会删本地文件）</span>';
    }else el.innerHTML='<span style="color:var(--text2)">未设置存档目录</span>';
}
function updArchiveInterval(v){S.archiveInterval=parseInt(v,10)||0;scheduleSave();if(typeof Archive!=='undefined')Archive.setInterval(S.archiveInterval);renderArchiveInfo();toast('存档间隔：'+(S.archiveInterval?S.archiveInterval+' 分钟':'关闭定时'));}
async function chooseArchiveDir(){if(typeof Archive==='undefined')return;const ok=await Archive.chooseDir();if(ok){Archive.setInterval(S.archiveInterval||10);renderArchiveInfo();await Archive.archiveAll({silent:false});}}
async function clearArchiveDir(){if(typeof Archive==='undefined')return;if(!confirm('确认关闭自动存档？（已存档文件不删）'))return;await Archive.clearDir();renderArchiveInfo();}
async function archiveNowBtn(){if(typeof Archive==='undefined')return;await Archive.archiveNow();}

/* ===== 会话设置 ===== */
function renderCSForm(){const c=curChat();if(!c)return;const sp=document.getElementById('spIn');if(sp)sp.value=c.systemPrompt||'';const si=document.getElementById('snapInterval');if(si)si.value=String(S.snapInterval||5);}
function updSP(v){const c=curChat();if(!c)return;c.systemPrompt=v||'';c.updatedAt=Date.now();scheduleSave();}
function updSnapInterval(v){S.snapInterval=parseInt(v,10)||0;scheduleSave();if(typeof Snapshot!=='undefined')Snapshot.startAuto(S.snapInterval,()=>S);toast('快照间隔：'+(S.snapInterval?S.snapInterval+' 分钟':'关闭'));}

async function renderStorageInfo(){
    const el=document.getElementById('storageInfo');if(!el)return;
    try{const info=await DB.getStorageInfo();el.innerHTML='已用：<strong>'+info.usedText+'</strong><br>配额：'+info.quotaText+'（'+info.percent+'%）<br>持久化：'+(info.persisted?'✅ 已启用':'⚠️ 未启用')+'<br>版本：'+APP_VERSION;}
    catch(e){el.textContent='存储信息获取失败';}
}
/* ===== 核心发送（融合：工作流泄露检测 + 多协议 + token统计 + 模式锁定 + 全量发送 + 知识库常驻） ===== */
async function coreSend(opts){
    opts=opts||{};
    let c=curChat();if(!c){newChat();c=curChat();}
    const profile=curProfile();
    if(!profile||!profile.key){toast('请先在 ⚙️ 中配置引擎 API Key','er');openM('set');return;}

    const visibleText=opts.visibleText,actualText=opts.actualText;
    const attsForUser=opts.atts||[];

    // 本轮一次性附件（图片 + 文本）
    let attachedText='';const imageAtts=[];
    attsForUser.forEach(a=>{if(a.type==='image')imageAtts.push(a);else if(a.text)attachedText+='\n\n=== 📎 附件：'+a.fileName+' ===\n'+a.text+'\n=== 附件结束 ===\n';});

    // 知识库（持续参考）：作为常驻上下文，每轮都注入
    let kbText='';const kbImages=[];
    if(c.knowledgeBase&&c.knowledgeBase.length){
        c.knowledgeBase.forEach(k=>{
            if(k.type==='image')kbImages.push({fileName:k.name,dataUrl:k.dataUrl,type:'image'});
            else if(k.text)kbText+='\n\n=== 📚 知识库：'+k.name+' ===\n'+k.text+'\n=== 知识库结束 ===\n';
        });
    }
    const composedUserText=(attachedText?attachedText+'\n':'')+actualText;

    const userMsg={id:gId(),role:'user',content:visibleText,_actual:actualText,attachments:attsForUser.map(a=>({name:a.fileName,type:a.type,ext:a.meta&&a.meta.ext})),_time:nowTime()};
    c.messages.push(userMsg);
    const aiMsg={id:gId(),role:'assistant',content:'',_streaming:true,_time:nowTime(),_engId:S.currentEngId};
    c.messages.push(aiMsg);

    /* 发送首条消息后锁定模式 */
    if(!c.modeLocked){
        if(!c.mode)c.mode=(S.uiMode==='workflow')?'workflow':'free';
        c.modeLocked=true;
        c.title=buildTitleWithSuffix(c.title,c.mode);
    }

    // 标题自动命名（保留模式后缀）
    const bareTitle=(c.title||'').replace(/-自由$/,'').replace(/-工作流$/,'').trim();
    if((bareTitle===''||bareTitle==='新对话')&&c.messages.length<=2){
        c.title=buildTitleWithSuffix((opts.titleHint||visibleText||'新对话').slice(0,24),chatMode(c));
    }
    c.updatedAt=Date.now();
    renderMs();renderSB();renderMode();

    /* ===== 构建发送消息（每轮全量；知识库进 system 常驻 + 可缓存） ===== */
    const sendMsgs=[];
    let systemContent='';
    if(c.systemPrompt&&c.systemPrompt.trim())systemContent+=c.systemPrompt.trim();
    if(kbText)systemContent+=(systemContent?'\n\n':'')+'【以下是持续参考的知识库资料，请在回答时参考】'+kbText;
    if(systemContent)sendMsgs.push({role:'system',content:systemContent});

    // 知识库图片 → 第一条 user 常驻（图片无法进 system）
    if(kbImages.length){
        const kbParts=[{type:'text',text:'【以下是持续参考的知识库图片】'}];
        kbImages.forEach(im=>kbParts.push({type:'image_url',image_url:{url:im.dataUrl}}));
        sendMsgs.push({role:'user',content:kbParts});
        sendMsgs.push({role:'assistant',content:'已收到知识库图片，我会在后续回答中参考。'});
    }

    // 历史对话（不含正在生成的 aiMsg）；用 m===userMsg 精准定位本轮，杜绝索引错位
    c.messages.forEach((m)=>{
        if(m===aiMsg)return;
        if(m._interrupted&&!m.content)return;
        if(m===userMsg){
            if(imageAtts.length){
                const parts=[];
                if(composedUserText)parts.push({type:'text',text:composedUserText});
                imageAtts.forEach(im=>parts.push({type:'image_url',image_url:{url:im.dataUrl}}));
                sendMsgs.push({role:'user',content:parts});
            }else{
                sendMsgs.push({role:'user',content:composedUserText||visibleText});
            }
        }else{
            sendMsgs.push({role:m.role,content:m._actual||m.content});
        }
    });

    await saveNow();
    const sendBtn=document.getElementById('sendBtn');sendBtn.classList.add('stop');sendBtn.textContent='■';
    const area=document.getElementById('msgsArea');const lastMsgEl=area.querySelector('.msg:last-child .bub');
    if(!lastMsgEl){console.error('bub not found');return;}
    const updater=UI.makeStreamUpdater(lastMsgEl,area);
    let lastSaveTime=Date.now();const SAVE_INTERVAL=3000;

    _streamCtrl=API.streamChat(profile,sendMsgs,{
        onStart:()=>{},
        onDelta:(d,full)=>{aiMsg.content=full;updater(full);if(Date.now()-lastSaveTime>SAVE_INTERVAL){lastSaveTime=Date.now();scheduleSave();}},
        onDone:async(full,usage)=>{
            let finalText=full;
            // 工作流泄露检测（仅工作流步骤触发 _wfLeakCheck）
            if(opts._wfLeakCheck&&typeof Workflow!=='undefined'&&Workflow.isLeak(full)){
                const masked='\u2588'.repeat(Math.min(Math.max(full.length,20),200));
                finalText='⚠️ 检测到尝试获取受保护内容，本次输出已被屏蔽。\n\n'+masked;
                const ctx=_wfAlertCtx||{};const cc=curChat();
                const reply20=String(full).replace(/\s+/g,'').slice(0,20);
                fireAlert('🚨 输出乱码警报（疑似套取隐藏指令）\n'+
                    '用户：'+(ctx.user||S.userName||'未署名')+'\n'+
                    '对话：《'+((cc&&cc.title)||'未命名')+'》\n'+
                    '预设：'+(ctx.preset||'-')+'\n'+
                    '步骤：'+(ctx.step||'-')+'\n'+
                    '他此前输入的内容为：'+(ctx.input||'-')+'\n'+
                    'AI回复前20字：'+reply20+'\n'+
                    '相似度：'+Workflow.similarityToLast(full)+'%\n'+
                    '时间：'+new Date().toLocaleString());
            }
            aiMsg.content=finalText;aiMsg._streaming=false;
            if(usage)aiMsg._usage=usage;
            c.updatedAt=Date.now();_streamCtrl=null;
            sendBtn.classList.remove('stop');sendBtn.textContent='➤';
            UI.fullRender(lastMsgEl,finalText);await saveNow();renderMs();renderSB();
            if(typeof Archive!=='undefined')Archive.notifyActivity();
        },
        onAbort:async(full,usage)=>{
            aiMsg.content=full;aiMsg._streaming=false;aiMsg._interrupted=true;
            if(usage)aiMsg._usage=usage;
            _streamCtrl=null;sendBtn.classList.remove('stop');sendBtn.textContent='➤';
            UI.fullRender(lastMsgEl,full||'_（已中断）_');await saveNow();renderMs();toast('已停止');
            if(typeof Archive!=='undefined')Archive.notifyActivity();
        },
        onError:async(err)=>{
            console.error('[Send]',err);
            aiMsg.content=(aiMsg.content||'')+'\n\n❌ **错误**：'+err.message;
            aiMsg._streaming=false;aiMsg._interrupted=true;_streamCtrl=null;
            sendBtn.classList.remove('stop');sendBtn.textContent='➤';
            UI.fullRender(lastMsgEl,aiMsg.content);await saveNow();toast('请求失败：'+err.message,'er');
        },
    });
}

async function send(){
    if(_streamCtrl){_streamCtrl.abort();return;}
    const inp=document.getElementById('uIn');const text=(inp.value||'').trim();
    if(!text&&!_pendingAtts.length){toast('请输入内容或上传附件','er');return;}
    const c=curChat();
    /* 仅工作流模式做敏感词检测；自由模式完全不受限 */
    if(c&&chatMode(c)==='workflow'){
        if(text&&guardSensitive(text,'工作流·自由输入'))return;
    }
    const profile=curProfile();
    /* ★ 生图引擎：走生图逻辑 */
    if(profile&&profile.engineType==='image'){
        if(!text){toast('请输入图片描述（prompt）','er');return;}
        inp.value='';aRsz(inp);
        await coreSendImage(text);
        return;
    }
    const userVisibleText=text||'(已上传 '+_pendingAtts.length+' 个附件)';
    const attsForUser=_pendingAtts.slice();
    inp.value='';aRsz(inp);_pendingAtts=[];renderAttList();
    await coreSend({visibleText:userVisibleText,actualText:text,atts:attsForUser,titleHint:text});
}

/* ===== 生图核心 ===== */
async function coreSendImage(prompt){
    let c=curChat();if(!c){newChat();c=curChat();}
    const profile=curProfile();
    if(!profile||!profile.key){toast('请先在 ⚙️ 中配置引擎 API Key','er');openM('set');return;}

    const userMsg={id:gId(),role:'user',content:prompt,_actual:prompt,_time:nowTime()};
    c.messages.push(userMsg);
    const aiMsg={id:gId(),role:'assistant',content:'🎨 正在生成图片...',_streaming:true,_time:nowTime(),_engId:S.currentEngId,_isImage:true};
    c.messages.push(aiMsg);

    if(!c.modeLocked){if(!c.mode)c.mode=(S.uiMode==='workflow')?'workflow':'free';c.modeLocked=true;c.title=buildTitleWithSuffix(c.title,c.mode);}
    const bareTitle=(c.title||'').replace(/-自由$/,'').replace(/-工作流$/,'').trim();
    if((bareTitle===''||bareTitle==='新对话')&&c.messages.length<=2){c.title=buildTitleWithSuffix(prompt.slice(0,24),chatMode(c));}
    c.updatedAt=Date.now();
    renderMs();renderSB();
    await saveNow();

    const sendBtn=document.getElementById('sendBtn');sendBtn.classList.add('stop');sendBtn.textContent='■';
    const area=document.getElementById('msgsArea');const lastMsgEl=area.querySelector('.msg:last-child .bub');

    _streamCtrl=API.generateImage(profile,prompt,{size:'1024x1024',n:1},{
        onStart:()=>{},
        onImage:async(imgs)=>{
            // 用 markdown 图片语法存进 content，渲染时变 <img>
            const md=imgs.map((u,i)=>'![生成图片'+(i+1)+']('+u+')').join('\n\n');
            aiMsg.content=md;aiMsg._streaming=false;c.updatedAt=Date.now();_streamCtrl=null;
            sendBtn.classList.remove('stop');sendBtn.textContent='➤';
            if(lastMsgEl)UI.fullRender(lastMsgEl,md);
            await saveNow();renderMs();renderSB();
            if(typeof Archive!=='undefined')Archive.notifyActivity();
        },
        onError:async(err)=>{
            aiMsg.content='❌ 生图失败：'+err.message;aiMsg._streaming=false;aiMsg._interrupted=true;_streamCtrl=null;
            sendBtn.classList.remove('stop');sendBtn.textContent='➤';
            if(lastMsgEl)UI.fullRender(lastMsgEl,aiMsg.content);
            await saveNow();toast('生图失败：'+err.message,'er');
        },
    });
}


async function regenerate(msg){
    const c=curChat();if(!c)return;
    const idx=c.messages.indexOf(msg);if(idx<1)return;
    const prev=c.messages[idx-1];if(prev.role!=='user'){toast('无法找到对应的提问','er');return;}
    const actual=prev._actual||(typeof prev.content==='string'?prev.content:'');
    const visible=typeof prev.content==='string'?prev.content:'';
    c.messages.splice(idx,1);c.messages.splice(idx-1,1);
    await saveNow();renderMs();
    await coreSend({visibleText:visible,actualText:actual,titleHint:visible});
}

/* ===== 输入区 / 键盘 / 模态框 ===== */
function aRsz(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,130)+'px';}
function hKey(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}}
function openM(n){const m=document.getElementById('mo-'+n);if(!m)return;m.classList.add('show');if(n==='cs'){renderCSForm();renderKBList();}if(n==='set'){renderEngTabs();renderEngForm();renderStorageInfo();renderGlobalSettings();}if(n==='exp')updExpPreview();if(n==='snap'&&IS_IOS){const w=document.getElementById('iosW');if(w)w.style.display='block';}}
function closeM(n){const m=document.getElementById('mo-'+n);if(m)m.classList.remove('show');}
function togSB(){document.getElementById('sb').classList.toggle('open');document.getElementById('sbOv').classList.toggle('show');}

/* ===== 附件 / 知识库 / 上传 ===== */
function togAtt(){document.getElementById('attPan').classList.toggle('show');}
function updAttCont(){_attContinuous=document.getElementById('attCont').checked;}
function onAtt(inputEl){Upload.fromInput(inputEl);}

async function _importShareFile(file){
    let password='';
    for(let attempt=0;attempt<3;attempt++){
        try{
            const result=await Snapshot.importSharedChat(file,password);
            const chat=result.chat;
            if(!chat.mode)chat.mode='free';chat.modeLocked=true;chat.folderId=chat.folderId||null;
            chat.title=buildTitleWithSuffix(chat.title,chat.mode);
            S.chats[chat.id]=chat;S.chatOrder.unshift(chat.id);S.currentChatId=chat.id;
            await saveNow();renderAll();
            toast('✅ 已导入分享对话'+(result.sharedBy?'（来自: '+result.sharedBy+'）':'')+'，可继续聊天！');return;
        }catch(e){
            if(e.code==='NEED_PASSWORD'||/口令/.test(e.message)){
                const pwd=prompt(attempt===0?'该分享文件已加密，请输入访问口令：':'口令错误，请重新输入（剩余 '+(3-attempt)+' 次）：','');
                if(pwd===null){toast('已取消导入');return;}password=pwd.trim();continue;
            }
            toast('❌ 导入分享失败：'+e.message,'er');return;
        }
    }
    toast('❌ 口令错误次数过多','er');
}

async function handleUploadedFiles(files){
    if(!files||!files.length)return;
    const fileArr=Array.from(files);
    const jsonFiles=fileArr.filter(f=>/\.json$/i.test(f.name));
    const otherFiles=fileArr.filter(f=>!/\.json$/i.test(f.name));
    for(const jf of jsonFiles){
        try{
            const ft=await Snapshot.detectFileType(jf);
            if(ft==='share'||ft==='enc'||ft==='enc-pwd'){await _importShareFile(jf);continue;}
            if(ft==='snapshot'){toast('📦 检测到快照文件，请通过 📦 快照迁移 导入','er');continue;}
            otherFiles.push(jf);
        }catch(e){otherFiles.push(jf);}
    }
    if(!otherFiles.length)return;
    toast('开始解析 '+otherFiles.length+' 个文件...');
    const results=await Parser.parseFiles(otherFiles);
    let okCount=0,failCount=0;
    results.forEach(r=>{if(r.ok){_pendingAtts.push(r.result);okCount++;}else{failCount++;toast('❌ '+r.file.name+'：'+r.error,'er');}});

    /* ★ 持续参考修复：实时读勾选框 + 没会话先建 + 明确提示 */
    const contChk=document.getElementById('attCont');
    const isContinuous=contChk?contChk.checked:_attContinuous;
    if(isContinuous&&okCount>0){
        let c=curChat();if(!c){newChat();c=curChat();}
        if(c){
            if(!c.knowledgeBase)c.knowledgeBase=[];
            let addedToKB=0;
            results.forEach(r=>{if(r.ok){c.knowledgeBase.push({id:gId(),name:r.result.fileName,type:r.result.type,text:r.result.text||'',dataUrl:r.result.dataUrl||null,meta:r.result.meta||{},addedAt:Date.now()});addedToKB++;}});
            c.updatedAt=Date.now();await saveNow();renderKBList();
            if(addedToKB>0)toast('📚 已加入持续参考（'+addedToKB+' 个文件），后续每轮都会自动参考');
        }
    }else{
        if(okCount>0)toast('✅ 已解析 '+okCount+' 个文件'+(failCount?'（'+failCount+' 失败）':''));
    }
    renderAttList();
}

function renderAttList(){
    const box=document.getElementById('attListBox'),list=document.getElementById('attList'),cnt=document.getElementById('attCount'),btn=document.getElementById('attBtn');
    if(!_pendingAtts.length){box.style.display='none';btn.classList.remove('has');return;}
    box.style.display='block';cnt.textContent='📎 '+_pendingAtts.length+' 个附件待发送';btn.classList.add('has');list.innerHTML='';
    _pendingAtts.forEach((a,idx)=>{
        const item=document.createElement('div');item.className='att-item';
        const icon=a.type==='image'?'🖼️':a.type==='table'?'📊':a.type==='document'?'📄':'📝';
        const nm=document.createElement('span');nm.className='ai-nm';nm.textContent=icon+' '+a.fileName;item.appendChild(nm);
        const sz=document.createElement('span');sz.className='ai-sz';sz.textContent=a.type==='image'?(a.meta.sizeText||''):(cntW(a.text)+' 字');item.appendChild(sz);
        const rm=document.createElement('button');rm.className='ai-rm';rm.textContent='×';rm.title='移除';rm.onclick=()=>{_pendingAtts.splice(idx,1);renderAttList();};item.appendChild(rm);
        list.appendChild(item);
    });
}
function clrAtt(){_pendingAtts=[];renderAttList();}

async function addKB(inputEl){
    if(!inputEl.files||!inputEl.files.length)return;
    const c=curChat();if(!c){toast('请先创建会话','er');return;}
    toast('解析知识库文件...');
    const results=await Parser.parseFiles(inputEl.files);
    if(!c.knowledgeBase)c.knowledgeBase=[];let ok=0;
    results.forEach(r=>{if(r.ok){c.knowledgeBase.push({id:gId(),name:r.result.fileName,type:r.result.type,text:r.result.text||'',dataUrl:r.result.dataUrl||null,meta:r.result.meta||{},addedAt:Date.now()});ok++;}else toast('❌ '+r.file.name+'：'+r.error,'er');});
    if(ok>0){c.updatedAt=Date.now();await saveNow();toast('✅ 已加入 '+ok+' 个知识库文件');}
    renderKBList();inputEl.value='';
}
function renderKBList(){
    const wrap=document.getElementById('kbList');if(!wrap)return;const c=curChat();
    if(!c||!c.knowledgeBase||!c.knowledgeBase.length){wrap.innerHTML='<div style="font-size:11px;color:var(--text2)">（暂无知识库文件）</div>';return;}
    wrap.innerHTML='';
    c.knowledgeBase.forEach((k,idx)=>{
        const item=document.createElement('div');item.className='att-item';item.style.marginBottom='4px';
        const icon=k.type==='image'?'🖼️':k.type==='table'?'📊':k.type==='document'?'📄':'📝';
        const nm=document.createElement('span');nm.className='ai-nm';nm.textContent=icon+' '+k.name;item.appendChild(nm);
        const sz=document.createElement('span');sz.className='ai-sz';sz.textContent=k.type==='image'?'图片':(cntW(k.text||'')+' 字');item.appendChild(sz);
        const rm=document.createElement('button');rm.className='ai-rm';rm.textContent='×';rm.title='移除';
        rm.onclick=async()=>{if(!confirm('从知识库移除 "'+k.name+'"？'))return;c.knowledgeBase.splice(idx,1);c.updatedAt=Date.now();await saveNow();renderKBList();};
        item.appendChild(rm);wrap.appendChild(item);
    });
}

/* ===== 快照 / 导入导出（含回滚备份 + 字段补齐） ===== */
function eSnap(){const includeKey=confirm('导出快照\n\n✅ 确定 = 含 API Key\n❌ 取消 = 不含 API Key');Snapshot.exportToFile(S,{includeKey:includeKey});}

async function iSnap(inputEl){
    if(!inputEl.files||!inputEl.files.length)return;const file=inputEl.files[0];
    try{await DB.saveRollbackBackup(S);}catch(e){console.warn('备份失败',e);}
    const mode=confirm('✅ 确定 = 替换模式\n❌ 取消 = 合并模式\n\n两种都会保护本地 API Key');
    try{
        const {state:imp,source}=await Snapshot.importFromFile(file);
        let finalState;
        if(mode){const {state:ps,protectedCount}=Snapshot.protectLocalKeys(imp,S);finalState=ps;if(protectedCount>0)toast('🔑 已保护 '+protectedCount+' 个 Key');}
        else{const {state:ps,protectedCount}=Snapshot.protectLocalKeys(imp,S);finalState=Snapshot.mergeStates(S,ps);if(protectedCount>0)toast('🔑 已保护 '+protectedCount+' 个 Key');}
        S=finalState;
        if(!Array.isArray(S.folders))S.folders=[];
        if(!S.folderCollapsed||typeof S.folderCollapsed!=='object')S.folderCollapsed={};
        if(!S.defaultMode)S.defaultMode='free';
        if(!S.profiles[S.currentEngId])S.currentEngId=Object.keys(S.profiles)[0]||'claude';
        fixProfileFields(); // ★ 补齐多协议/缓存/价格字段
        await saveNow();await Snapshot.snapNow(S);renderAll();
        toast('✅ 导入成功（'+source+'）：'+Object.keys(S.chats||{}).length+' 个会话');closeM('snap');
    }catch(e){console.error('[Import]',e);toast('导入失败：'+e.message,'er');}
    inputEl.value='';
}

async function rollbackImport(){
    let bak=null;
    try{bak=await DB.loadRollbackBackup();}catch(e){}
    if(!bak||!bak.state){toast('暂无可恢复的备份（仅在导入快照后才有）','er');return;}
    const t=bak.ts?new Date(bak.ts).toLocaleString():'未知时间';
    if(!confirm('⏪ 恢复到上次导入前的数据？\n\n备份时间：'+t+'\n\n⚠️ 当前数据将被该备份覆盖，且此备份会被清除（只能回滚一次）。'))return;
    try{
        S=bak.state;
        if(!S.profiles||!Object.keys(S.profiles).length)S.profiles=JSON.parse(JSON.stringify(API.DEFAULT_PROFILES));
        if(!Array.isArray(S.folders))S.folders=[];
        if(!S.folderCollapsed||typeof S.folderCollapsed!=='object')S.folderCollapsed={};
        if(!S.defaultMode)S.defaultMode='free';
        if(!S.profiles[S.currentEngId])S.currentEngId=Object.keys(S.profiles)[0]||'claude';
        fixProfileFields();
        if(!S.currentChatId||!S.chats[S.currentChatId]){if(S.chatOrder&&S.chatOrder.length&&S.chats[S.chatOrder[0]])S.currentChatId=S.chatOrder[0];else S.currentChatId=null;}
        await saveNow();await DB.clearRollbackBackup();renderAll();
        toast('✅ 已恢复到导入前的数据');closeM('snap');
    }catch(e){console.error('[Rollback]',e);toast('恢复失败：'+e.message,'er');}
}

/* ===== 对话导出（TXT / Markdown / HTML / Word） ===== */
function updExp(){_exportMode=document.getElementById('expFmt').value;updExpPreview();}
function buildExportContent(chatArg,modeArg){
    const c=chatArg||curChat();const mode=modeArg||_exportMode;
    if(!c||!c.messages||!c.messages.length)return{plain:'（无内容）',html:'<p>（无内容）</p>',title:'空对话',md:'（无内容）'};
    const title=c.title||'对话记录';const isPure=mode==='pure';let plain='',html='',mdOut='';
    if(!isPure){
        plain='【'+title+'】\n导出时间：'+new Date().toLocaleString()+'\n\n';
        mdOut='# '+title+'\n\n> 导出时间：'+new Date().toLocaleString()+'\n\n';
        html='<h1>'+esc(title)+'</h1><p style="color:#888;font-size:12px">导出时间：'+esc(new Date().toLocaleString())+'</p><hr>';
    }
    c.messages.forEach((m)=>{
        const text=typeof m.content==='string'?m.content:JSON.stringify(m.content);
        if(isPure){if(m.role==='assistant'&&text){plain+=text+'\n\n';mdOut+=text+'\n\n---\n\n';html+=UI.renderMarkdown(text)+'<hr style="border:none;border-top:1px dashed #ccc;margin:24px 0">';}}
        else{const roleName=m.role==='user'?'👤 我':(m.role==='assistant'?'🤖 AI':'⚙️ 系统');
            plain+='【'+roleName+'】'+(m._time?' '+m._time:'')+'\n'+text+'\n\n';
            mdOut+='## '+roleName+(m._time?' ('+m._time+')':'')+'\n\n'+text+'\n\n';
            html+='<div style="margin:18px 0;padding:12px 16px;background:'+(m.role==='user'?'#e3f2fd':'#f5f5f5')+';border-radius:8px"><strong>'+esc(roleName)+'</strong>'+(m._time?' <span style="color:#888;font-size:12px">'+esc(m._time)+'</span>':'')+'<div style="margin-top:6px">'+(m.role==='assistant'?UI.renderMarkdown(text):'<pre style="white-space:pre-wrap;font-family:inherit;margin:0">'+esc(text)+'</pre>')+'</div></div>';}
    });
    return{plain:plain.trim(),html:html,title:title,md:mdOut.trim()};
}
function buildArchiveHtml(chat){
    const {html,title}=buildExportContent(chat,'full');
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'+esc(title)+'</title><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css"><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;line-height:1.7;color:#222}pre{background:#f6f8fa;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px}code{font-family:SF Mono,Consolas,monospace}table{border-collapse:collapse;margin:12px 0}th,td{border:1px solid #ddd;padding:6px 12px}th{background:#f0f0f0}blockquote{border-left:4px solid #667eea;padding-left:12px;color:#666;margin:8px 0}img{max-width:100%}</style></head><body>'+html+'</body></html>';
}
function updExpPreview(){const ta=document.getElementById('expTA');if(!ta)return;ta.value=buildExportContent().plain;}
function eTxt(){const {plain,title}=buildExportContent();dl(plain,(title||'chat')+'-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+'.txt','text/plain');toast('✅ TXT 已导出');}
function eMd(){const {md,title}=buildExportContent();dl(md,(title||'chat')+'-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+'.md','text/markdown');toast('✅ Markdown 已导出');}
function eHtml(){const c=curChat();const full=buildArchiveHtml(c);const {title}=buildExportContent();dl(full,(title||'chat')+'-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+'.html','text/html');toast('✅ HTML 已导出');}
function eDoc(){const {html,title}=buildExportContent();const full='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><title>'+esc(title)+'</title><style>body{font-family:微软雅黑,Microsoft YaHei,Arial;line-height:1.7;font-size:14px}pre{background:#f6f8fa;padding:8px;border:1px solid #ddd;font-family:Consolas,monospace}table{border-collapse:collapse}th,td{border:1px solid #999;padding:4px 8px}</style></head><body>'+html+'</body></html>';dl(full,(title||'chat')+'-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+'.doc','application/msword');toast('✅ Word 已导出');}
function cpExp(){const ta=document.getElementById('expTA');if(!ta||!ta.value){toast('无内容','er');return;}ta.select();try{document.execCommand('copy');toast('✅ 已复制');}catch(e){navigator.clipboard.writeText(ta.value).then(()=>toast('✅ 已复制'));}}

/* ===== 初始化 ===== */
async function initApp(){
    try{
        await DB.init();await DB.migrateFromLocalStorage();await DB.requestPersistent();await loadState();
        if(!S.currentChatId||!S.chats[S.currentChatId]){if(S.chatOrder.length&&S.chats[S.chatOrder[0]])S.currentChatId=S.chatOrder[0];else newChat();}
        renderAll();initUpload();initSnapshot();await initArchive();await initWorkflow();checkURLImport();maybePromptAuth();
        toast('✅ 飞凡AI 就绪');
    }catch(e){console.error('[InitApp]',e);toast('初始化失败：'+e.message,'er');}
}
function initUpload(){if(typeof Upload==='undefined')return;Upload.onFiles(handleUploadedFiles);Upload.init({dropTarget:document.getElementById('msgsArea'),dropMask:document.getElementById('dropMask'),paste:true});}
function initSnapshot(){if(typeof Snapshot==='undefined')return;Snapshot.startAuto(S.snapInterval||5,()=>S);}
async function initArchive(){if(typeof Archive==='undefined')return;await Archive.init({getState:()=>S,buildHtml:(chat)=>buildArchiveHtml(chat),intervalMin:S.archiveInterval!==undefined?S.archiveInterval:10,debounceMin:1});}
async function initWorkflow(){if(typeof Workflow==='undefined')return;await Workflow.load('presets.json');renderMode();}

/* ===== 存档授权提示 ===== */
function maybePromptAuth(){if(typeof Archive==='undefined')return;if(Archive.needsAuth())showAuthModal();}
function showAuthModal(){const m=document.getElementById('mo-auth');if(!m)return;const n=document.getElementById('authDirName');if(n)n.textContent=Archive.getDirName()||'已设定目录';m.classList.add('show');}
function closeAuthModal(){const m=document.getElementById('mo-auth');if(m)m.classList.remove('show');}
async function doAuthNow(){if(typeof Archive==='undefined')return;const ok=await Archive.requestAuthNow();if(ok){closeAuthModal();toast('✅ 存档已授权');renderArchiveInfo();Archive.archiveAll({silent:true});}else toast('授权未通过，可在 ⚙️ 中重试','er');}

/* ===== URL 参数导入分享对话 ===== */
async function checkURLImport(){
    const params=new URLSearchParams(window.location.search);const shareUrl=params.get('share');if(!shareUrl)return;
    try{
        toast('正在加载分享对话...');const resp=await fetch(shareUrl);if(!resp.ok)throw new Error('HTTP '+resp.status);
        const raw=await resp.json();let password='';
        if(raw&&raw.__feifan_enc__&&raw.hasPassword){const pwd=prompt('该分享已加密，请输入访问口令：','');password=pwd?pwd.trim():'';}
        const result=await Snapshot.normalizeSharedObject(raw,password);const chat=result.chat;
        if(!chat.mode)chat.mode='free';chat.modeLocked=true;chat.folderId=chat.folderId||null;
        chat.title=buildTitleWithSuffix(chat.title,chat.mode);
        S.chats[chat.id]=chat;S.chatOrder.unshift(chat.id);S.currentChatId=chat.id;await saveNow();renderAll();
        toast('✅ 已导入分享对话'+(result.sharedBy?'（来自: '+result.sharedBy+'）':'')+'，可继续聊天！');
        window.history.replaceState({},'',window.location.pathname);
    }catch(e){console.error('[URLImport]',e);toast('分享链接加载失败：'+e.message,'er');}
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initApp);else initApp();
window.addEventListener('beforeunload',()=>{if(_streamCtrl){try{DB.saveState(S);}catch(e){}}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){const setM=document.getElementById('mo-set');if(setM&&setM.classList.contains('show'))renderStorageInfo();}});
if('serviceWorker' in navigator){window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js').then(reg=>console.log('[PWA] SW',reg.scope)).catch(err=>console.warn('[PWA] SW fail',err));});}
