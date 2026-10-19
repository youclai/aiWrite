// 建议8：问题反馈分区渲染 + 用户说明弹层（隐私免责/提交规则/版本）
var A = globalThis.NOVEL_APP, V = globalThis.NOVEL_VIEWS;
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var log = [];
A.go('#/me/feedback'); await wait(800);
var mail = document.getElementById('fbMailText');
log.push('email=' + (mail ? mail.textContent : 'MISSING') + ' expected=' + V.FEEDBACK_EMAIL);
log.push('fbCopy=' + !!document.getElementById('fbCopy') + ' fbCompose=' + !!document.getElementById('fbCompose') + ' fbKind=' + !!document.getElementById('fbKind') + ' fbText=' + !!document.getElementById('fbText'));
log.push('userDocBtn=' + !!document.getElementById('userDocBtn'));
// 打开用户说明弹层
document.getElementById('userDocBtn').click(); await wait(400);
var doc = [].filter.call(document.querySelectorAll('.sheet'), function (s) { return !s.hidden && /用户说明/.test(s.textContent); })[0];
if (!doc) { log.push('userDocSheet=MISSING'); return log.join('\n'); }
var dt = doc.textContent;
log.push('docPrivacy=' + /不上传任何服务器/.test(dt) + ' docKeystore=' + /Keystore/.test(dt));
log.push('docRules=' + /问题反馈与提交规则/.test(dt) + ' docVersion=' + /当前版本\s*v3\.22/.test(dt));
log.push('docEmail=' + /3620522389@qq\.com/.test(dt));
return log.join('\n');
