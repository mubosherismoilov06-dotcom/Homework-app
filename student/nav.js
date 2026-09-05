function renderStudentNav(active) {
  const items = [['My Homework', '/student/'], ['Leaderboard', '/student/leaderboard.html']];
  const links = items.map(([label, href]) =>
    `<a href="${href}" class="${active === label ? 'active' : ''}">${label}</a>`
  ).join('');
  document.body.insertAdjacentHTML('afterbegin',
    `<nav><div class="wrap">${links}<a href="#" onclick="logout()">Log Out</a></div></nav>`);
}
