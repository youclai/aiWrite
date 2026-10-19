var A = globalThis.NOVEL_APP;
A.go('#/me/import');
await new Promise(function (r) { setTimeout(r, 800); });
return location.hash;
