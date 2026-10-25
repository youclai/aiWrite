/* devtools-add-cast.cjs —— 按软件界面字段格式，把《勇者》第1章「童年的那顿饭」的
   角色卡与势力设定录入设备 App（走 NOVEL_DB.saveCharacter / saveFaction，
   与界面「新增人物/新增势力」表单提交同一条代码路径、同一字段映射）。
   用法：
     node tests/devtools-add-cast.cjs preflight   # 只回显将要写入的清单，不写库
     node tests/devtools-add-cast.cjs doit        # 真正写入
   前置：App 已打开，adb forward 已建立。幂等：同名已存在则跳过（UPDATE 语义走界面，不在此脚本）。 */
const BASE = process.env.DEV_BASE || 'http://127.0.0.1:9222';
const MODE = process.argv[2] || 'preflight';
const BOOK_ID = 5;

const CHARACTERS = [
  { name: '奥莱特斯', role: '主角', gender: '男', age: '少年（全文未给定岁数）',
    personality: '沉默、执拗于"数得清"，先观察后行动；受村长"先看脚下"影响极深；把自己想做的事说得很大却不敢说出口',
    speech_style: '短句直答；学薇拉和村长的说话节奏（"下一个你明天再学"）；关键心愿只在心里完整成形',
    taboos: '夜袭中守门顶门、杀死闯入教堂的怪物；事后拒绝随车同行、拒绝近卫骑士之邀，说"我要自己走一段"，带一截柴棒两块干粮独往城里；林中回应无名"声音"的问答。前期不得让他轻易加入任何组织；"想做所有生灵的骑士、做伟大的勇者"只能是心里没说全的话',
    background: '来历不明的孤儿，村长只说"仓库那头空着，你去睡"；从小替村里数烟囱、看门槛鞋、记人口，是村长分东西时的"左手边"' },
  { name: '村长', role: '重要配角（第一章末死亡）', gender: '男', age: '年长（未给定）',
    personality: '沉默公正、观察入微（先看门槛、先看脚下）；重实效不表情感；对奥莱特斯如父',
    speech_style: '短句命令式，一句一句分开喊（"套。""进教堂。"）；用动作代替表态（把刀立起来切三块推成一排）',
    taboos: '村中自治首领，无血缘权威，凭分物公正与记人细致服众；定下"先给站在你旁边的人"的规矩，把奥莱特斯算入自家"三口"、明示他为继承人（"往后我念不动了，你替我念"）。夜袭时提未点燃的火把站院口喊三句集合令，最终阵亡于教堂门外七步处，衣服叠得方方正正；奥莱特斯与薇拉以"往北"与"替他数"延续其意志',
    background: '常持一把木柄磨得发亮的短刀（分东西用）；屋内桌上三只碗（左二右一）、门里侧两双鞋（一大一小皆鞋头朝外）——第一章未解释的悬念，不得由AI随意填解' },
  { name: '薇拉', role: '主要配角（第一章末离村）', gender: '女', age: '少年（比奥莱特斯能领事，未给定）',
    personality: '冷静克制、责任感先于恐惧、嘴硬心软；答应得快得像早就想好；行动先于言语',
    speech_style: '短句命令式："拿好。""别用手，用肩。""你看着他们。"重复时第二遍比第一遍轻；极少解释',
    taboos: '夜袭中把孩子们一个个按进教堂、守门顶门、安抚最小孩童；父母双亡后被教会认定为圣女，答应对他们走以换救治村人，带着奥莱特斯归还的名册上车离村，走前回头一次没说话。此后与奥莱特斯分离，不得随意写两人见面重逢',
    background: '牧师之女；白天在教堂门槛上点人认字、记名字册；名字不在她自己记的那一列上；母亲死于夜袭' },
  { name: '薇拉父亲（牧师）', role: '配角（第一章死亡）', gender: '男', age: '中年',
    personality: '克制内敛，不骂人也不劝人，情绪只以"把眉头放下去"表达；对村落事务保持距离（在场边看不介入）',
    speech_style: '声音不高，念纸上的字不解释内容；一年给村里念一次从城里来的纸；给门槛上的孩子一遍遍念名字',
    taboos: '从大城市来的这一带牧师，识字；纸是他裁的，一张裁三条，谁把字弄脏了要挨他一句。夜袭中重伤，死于教堂院内船板旁（薇拉按过第十三个即是他）；其名字册由薇拉传回奥莱特斯手中',
    background: '携家驻村传教，与村自治（村长）各管一段、互不越界' },
  { name: '薇拉母亲', role: '配角（第一章死亡）', gender: '女', age: '中年',
    personality: '全文未展开——只能按"不喧宾、伤重仍自持"的分量写，禁止加戏',
    speech_style: '第一章无台词',
    taboos: '夜袭中重伤，肋下被薇拉按压许久手终未抬起，死于教堂院内；"她父母没救了"是教会劝薇拉随行的第一条理由',
    background: '牧师之妻；最后姿态是坐着、膝上放着薇拉父亲之衣角，另一手撑地指下压着一块碎砖' },
  { name: '狩猎队队长', role: '配角', gender: '男', age: '成年',
    personality: '守序敬上：出归必数人头（十一口出去十一口回来才让车进村）；有过遮掩（有洞的鹿皮洞面朝下摆不敢给村长看）',
    speech_style: '报功一件一件报、简短分明；对村长服膺，出错后自认（当晚把洞朝上翻回来）',
    taboos: '村中十一人狩猎队的头目；分猎物时由他报功劳、村长记账动刀；夜袭后带队守村善后',
    background: '狗的主人在队中牵狗；队长与村长构成"报—记—切"的分物秩序' },
  { name: '声音（无名者）', role: '神秘角色（身份未明）', gender: '未知', age: '未知',
    personality: '不露面不催促，以问句引导；"照实答"不是商量的意思——被问者口中会出来自己没想到的话',
    speech_style: '很轻也很稳，像站在很远的地方说话、又贴着人耳朵；只问不答（"我该往哪边睡"得不到回应）',
    taboos: '在奥莱特斯独行林中发问（你想要做什么/理想是什么/要放弃吗/为什么一个人走）；事后奥莱特斯对它一句也复述不全，说出来只有风穿过草的声音。身份、来历、所属第一章一律未明，AI 不得提前揭示或让它主动现身干预剧情',
    background: '第一章仅以声音出现，无形体无位置' },
  { name: '数手指的女孩', role: '配角（村中最小的孩子）', gender: '女', age: '幼童',
    personality: '惊惧时靠数事情止住哭；对数字与"明天"有超出年龄的执信',
    speech_style: '问句接连不断："他们不进来吗。""下一个数是什么。""明天还学不学。"',
    taboos: '夜袭时躲在教堂门后捧着自己的膝盖不哭不出声，被奥莱特斯以"数自己的手指"安抚；拉着薇拉湿掉的袖口问明天还学不学，得到"学"。她是奥莱特斯"让她明天还学得着"这个誓言的对象，也是薇拉离村前最放不下的孩子',
    background: '村中学童之一，名字未给出' },
  { name: '下马的那一位', role: '配角（教会一方领队人物）', gender: '男', age: '成年（未给定）',
    personality: '说话节奏很慢、一句与一句之间空一口气那么长，像村长；观察细致（在石阶下把堂里孩子守门看得清清楚楚）；讲分寸不逼人不越线（始终不迈过教堂门槛）',
    speech_style: '慢，先陈述再发问："愿不愿意做她的近卫骑士"；被拒后不问第二遍，只留一句"我建议他想一想"，且声音压低是说给自己人听的',
    taboos: '第五节夜中抱臂立在门外亮里、背对堂里，看奥莱特斯那一眼比看谁都久；第六节下马走到石阶下，先赞堂里守门的孩子、再邀奥莱特斯做薇拉的近卫骑士，被"我不去。我要自己走一段"回绝。与"声音"是否同一者第一章未明，不得坐实',
    background: '随大主教一行进驻村口的当兵头面人物，身份职司未明' }
];

const FACTIONS = [
  { name: '教会', kind: '宗教组织',
    intro: '从城里来的宗教权力机构，这一带的牧师（薇拉父亲）属它；大主教为其在村中的最高来人，有马队与兵员。掌"圣女"认定权。夜袭后进驻村口、拴马支锅，以救治受伤村民为条件带走薇拉，并向奥莱特斯发出近卫骑士之邀；行事讲条件，其神职者从不迈过教堂门槛。与村自治（村长）互不统属' },
  { name: '村中教堂', kind: '建筑/场所',
    intro: '全村最高最好的屋子：河滩石起墙、整木为梁、顶铺瓦，全村唯一不漏雨；供着说不出名字的木头脸与矮台子，门后堆干柴、钉上挂村长旧刀（木鞘裂口，第五节由奥莱特斯取下杀敌，刃上血未干）。平日孩子门槛认字、晚上村民议事，夜袭时是十九个孩子的避难所；门闩横木架双铁环。它既是村级自治的议事厅，也是教会与村子之间的灰色地带' },
  { name: '村长一家（三口）', kind: '村级编户',
    intro: '村里的编户以"人口"计，村长自报"三口"：他自己、被算入一家的奥莱特斯（"这一份你替我端"）、以及门里侧一大一小两双鞋、桌上左边两只始终有人进食的碗所指向的未说明的两人。左二右一三只碗、两双鞋鞋头朝外是第一章未解释的悬念，涉及村长过往，AI 不得随意填解。奥莱特斯的"左手边"位置由村长一指而定，成为村里办事先看的秩序标记' }
];

const payload = JSON.stringify({ bookId: BOOK_ID, characters: CHARACTERS, factions: FACTIONS });

const EXPR = `(async () => {
  const DB = globalThis.NOVEL_DB;
  const P = ${payload};
  const MODE = ${JSON.stringify(MODE)};
  const out = { mode: MODE };
  const existC = await DB.listCharacters(P.bookId);
  const existF = await DB.listFactions(P.bookId);
  out.existedCharacters = existC.map(c => c.name);
  out.existedFactions = existF.map(f => f.name);
  if (MODE !== 'doit') {
    out.planCharacters = P.characters.map(c => ({ name: c.name, act: existC.some(x => x.name === c.name) ? 'skip(同名已存在)' : 'create' }));
    out.planFactions = P.factions.map(f => ({ name: f.name, act: existF.some(x => x.name === f.name) ? 'skip(同名已存在)' : 'create' }));
    return JSON.stringify(out);
  }
  out.doneCharacters = []; out.doneFactions = [];
  for (const c of P.characters) {
    if (existC.some(x => x.name === c.name)) { out.doneCharacters.push({ name: c.name, act: 'skip' }); continue; }
    const id = await DB.saveCharacter(P.bookId, c);
    out.doneCharacters.push({ name: c.name, act: 'create', id });
  }
  for (const f of P.factions) {
    if (existF.some(x => x.name === f.name)) { out.doneFactions.push({ name: f.name, act: 'skip' }); continue; }
    const id = await DB.saveFaction(P.bookId, f);
    out.doneFactions.push({ name: f.name, act: 'create', id });
  }
  out.totalCharacters = (await DB.listCharacters(P.bookId)).length;
  out.totalFactions = (await DB.listFactions(P.bookId)).length;
  return JSON.stringify(out);
})()`;

(async () => {
  const targets = await (await fetch(BASE + '/json')).json();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('NO_PAGE_TARGET'); process.exitCode = 3; return; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pend.has(msg.id)) { const p = pend.get(msg.id); pend.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } };
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  const val = r && r.result && r.result.value;
  if (!val) { console.log('EVAL_FAIL', JSON.stringify(r && r.exceptionDetails)); ws.close(); process.exitCode = 4; return; }
  console.log(JSON.stringify(JSON.parse(val), null, 2));
  ws.close();
})().catch(e => { console.error('PROBE_ERR', e.message); process.exitCode = 2; });
