var A = globalThis.NOVEL_APP;
A.go('#/me/feedback');
await new Promise(function (r) { setTimeout(r, 700); });
document.getElementById('userDocBtn').click();
await new Promise(function (r) { setTimeout(r, 400); });
return 'userdoc open';
