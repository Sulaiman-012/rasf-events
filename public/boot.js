// Runs in <head>: switch to the portrait LG layout before first paint.
if (location.pathname.indexOf('/screen') === 0) document.documentElement.classList.add('screen-mode');
