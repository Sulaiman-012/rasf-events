/*
  Rasf platform settings (edit, commit, and redeploy to apply).
  Polling intervals in milliseconds. Every poll is one Worker request, so larger
  numbers mean fewer requests against the free daily allowance.
    screenPollMs   LG screens check for new content / questions
    phonePollMs    employee phones and the results page
    adminPollMs    the admin dashboard
    heartbeatMs    each screen reports "online" to the admin dashboard
*/
window.RASF_CONFIG = {
  screenPollMs: 5000,
  phonePollMs: 8000,
  adminPollMs: 10000,
  heartbeatMs: 60000,
  kioskResetMs: 7000,
};
