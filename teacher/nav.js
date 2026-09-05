function renderTeacherNav(active) {
  const items = [
    ['Dashboard', '/teacher/'],
    ['Students', '/teacher/students.html'],
    ['Groups', '/teacher/groups.html'],
    ['Homework', '/teacher/homework.html'],
    ['Leaderboard', '/teacher/leaderboard.html'],
  ];
  const links = items.map(([label, href]) =>
    `<a href="${href}" class="${active === label ? 'active' : ''}">${label}</a>`
  ).join('');
  document.body.insertAdjacentHTML('afterbegin',
    `<nav><div class="wrap-wide">${links}<a href="#" onclick="logout()">Log Out</a></div></nav>`);
}
