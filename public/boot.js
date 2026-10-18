// Runs in <head>: switch to the portrait LG layout before first paint (/screen/<key> and the shared /tv link).
var rasfPath = location.pathname.replace(/\/+$/, '');
if (rasfPath.indexOf('/screen') === 0 || rasfPath === '/tv') document.documentElement.classList.add('screen-mode');
