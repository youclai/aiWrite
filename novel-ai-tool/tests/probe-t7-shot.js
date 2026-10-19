var A = globalThis.NOVEL_APP;
A.go('#/editor/1/7');
await new Promise(function (r) { setTimeout(r, 900); });
document.getElementById('fabBtn').click();
await new Promise(function (r) { setTimeout(r, 300); });
document.querySelector('.fab-item[data-kind="polish"]').click();
await new Promise(function (r) { setTimeout(r, 400); });
return 'hint shown';
