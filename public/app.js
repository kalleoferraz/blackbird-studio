// Login, password change and the admin's Accounts screen. No build step; all text goes in through
// textContent, never innerHTML, so names and emails cannot inject markup.

const root = document.getElementById('root');
const state = { me: null, projects: [], view: 'home' };

/** Creates an element: h('button', { class: 'primary', onclick }, 'Save'). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body.message || body.error || `Error ${status}`);
    this.status = status;
    this.code = body.error;
  }
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

const MESSAGES = {
  invalid_credentials: 'Email or password is wrong.',
  too_many_attempts: 'Too many attempts. Try again in a few minutes.',
  auth_not_configured: 'Login is not set up on the server (SESSION_SECRET).',
  wrong_password: 'The current password is wrong.',
  email_taken: 'An account with this email already exists.',
  invalid_email: 'That is not a valid email address.',
  invalid_display_name: 'Enter a name of up to 100 characters.',
  cannot_disable_yourself: 'You cannot disable your own account.',
};
const describe = (err) => MESSAGES[err.code] || err.message || 'Something went wrong.';

function render(...nodes) {
  root.replaceChildren(...nodes);
}

// ---- login ------------------------------------------------------------------

function loginView() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, autofocus: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Log in');
  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        applyMe(await api('POST', '/api/login', { email: email.value, password: password.value }));
        show();
      } catch (err) {
        error.textContent = describe(err);
        submit.disabled = false;
      }
    },
  }, h('label', {}, 'Email'), email, h('label', {}, 'Password'), password, error, h('p', {}, submit));
  render(h('div', { class: 'panel narrow' }, h('h1', {}, 'Redaction Studio'), form));
}

// ---- password change ------------------------------------------------------------

function passwordView(forced) {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Change password');
  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      error.textContent = '';
      if (next.value !== again.value) {
        error.textContent = 'The two new passwords are not the same.';
        return;
      }
      submit.disabled = true;
      try {
        applyMe(await api('POST', '/api/me/password', { currentPassword: current.value, newPassword: next.value }));
        state.view = 'home';
        show();
      } catch (err) {
        error.textContent = describe(err);
        submit.disabled = false;
      }
    },
  },
    h('label', {}, forced ? 'Temporary password' : 'Current password'), current,
    h('label', {}, 'New password (at least 10 characters)'), next,
    h('label', {}, 'New password again'), again,
    error,
    h('p', { class: 'row' }, submit, forced ? null : h('button', { type: 'button', onclick: () => { state.view = 'home'; show(); } }, 'Cancel')),
  );
  render(h('div', { class: 'panel narrow' },
    h('h1', {}, 'Choose a new password'),
    forced ? h('p', { class: 'muted' }, 'You are using a temporary password. Choose your own to continue.') : null,
    form,
  ));
}

// ---- home -----------------------------------------------------------------------

function bar() {
  return h('header', { class: 'bar' },
    h('h1', {}, 'Redaction Studio'),
    h('nav', {},
      h('span', { class: 'muted' }, state.me.displayName),
      state.me.isAdmin ? h('button', { onclick: () => { state.view = state.view === 'accounts' ? 'home' : 'accounts'; show(); } }, state.view === 'accounts' ? 'Projects' : 'Accounts') : null,
      h('button', { onclick: () => { state.view = 'password'; show(); } }, 'Change password'),
      h('button', { onclick: logout }, 'Log out'),
    ),
  );
}

function homeView() {
  const list = state.projects.length
    ? h('ul', { class: 'plain' }, state.projects.map((p) => h('li', {}, h('span', {}, p.title), h('span', { class: 'muted' }, p.role))))
    : h('p', { class: 'muted' }, 'You are not a member of any project yet.');
  render(bar(), h('div', { class: 'panel' }, h('h2', {}, 'Your projects'), list));
}

// ---- accounts (admin) -----------------------------------------------------------

async function accountsView(notice) {
  let data;
  try {
    data = await api('GET', '/api/admin/users');
  } catch (err) {
    return handleFailure(err);
  }
  const noticeBox = notice ? h('div', { class: 'notice' },
    h('div', {}, `Temporary password for ${notice.who}: `, h('code', {}, notice.password)),
    h('div', { class: 'muted' }, 'Shown only now. Hand it over privately; the person must replace it at first login.'),
  ) : null;

  const email = h('input', { type: 'email', required: true, placeholder: 'name@example.com' });
  const name = h('input', { type: 'text', required: true, maxlength: '100', placeholder: 'Display name' });
  const error = h('p', { class: 'error', role: 'alert' });
  const create = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      error.textContent = '';
      try {
        const result = await api('POST', '/api/admin/users', { email: email.value, displayName: name.value });
        accountsView({ who: result.email, password: result.temporaryPassword });
      } catch (err) {
        error.textContent = describe(err);
      }
    },
  }, h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Email'), email), h('div', {}, h('label', {}, 'Name'), name), h('button', { class: 'primary', type: 'submit' }, 'Create account')), error);

  const users = data.users.map((u) => userCard(u, data));
  render(bar(), noticeBox, h('div', { class: 'panel' }, h('h2', {}, 'New account'), h('p', { class: 'muted' }, 'A temporary password is generated for you to hand over.'), create),
    h('div', { class: 'panel' }, h('h2', {}, `Accounts (${data.users.length})`), users));
}

function userCard(u, data) {
  const act = (fn) => async () => {
    try { await fn(); } catch (err) { alert(describe(err)); }
  };
  const memberList = u.memberships.length
    ? h('ul', { class: 'plain' }, u.memberships.map((m) => h('li', {},
      h('span', {}, `${m.title} `, h('span', { class: 'muted' }, `(${m.role})`)),
      h('button', { class: 'danger', onclick: act(async () => { await api('DELETE', `/api/admin/users/${u.id}/memberships/${m.projectId}`); accountsView(); }) }, 'Remove'))))
    : h('p', { class: 'muted' }, 'No projects.');

  let add = null;
  if (data.projects.length) {
    const projectSelect = h('select', {}, data.projects.map((p) => h('option', { value: p.id }, p.title)));
    const roleSelect = h('select', {}, data.roles.map((r) => h('option', { value: r }, r)));
    add = h('div', { class: 'add-membership' }, projectSelect, roleSelect,
      h('button', { onclick: act(async () => { await api('PUT', `/api/admin/users/${u.id}/memberships/${projectSelect.value}`, { role: roleSelect.value }); accountsView(); }) }, 'Add or change role'));
  }

  return h('div', { class: 'user' },
    h('div', { class: 'head' },
      h('div', {}, h('strong', {}, u.displayName), ' ', h('span', { class: 'muted' }, u.email),
        u.isAdmin ? h('span', { class: 'badge' }, 'admin') : null,
        u.disabled ? h('span', { class: 'badge warn' }, 'disabled') : null,
        u.mustChangePassword ? h('span', { class: 'badge' }, 'temporary password') : null)),
    memberList, add,
    h('div', { class: 'actions' },
      h('button', { onclick: act(async () => {
        if (!confirm(`Set a new temporary password for ${u.email}? Their current password and sessions stop working.`)) return;
        const result = await api('POST', `/api/admin/users/${u.id}/reset-password`);
        accountsView({ who: u.email, password: result.temporaryPassword });
      }) }, 'Reset password'),
      u.id === state.me.id ? null : h('button', { class: u.disabled ? '' : 'danger', onclick: act(async () => {
        await api('POST', `/api/admin/users/${u.id}/disabled`, { disabled: !u.disabled });
        accountsView();
      }) }, u.disabled ? 'Enable' : 'Disable')),
  );
}

// ---- flow -----------------------------------------------------------------------

function applyMe(payload) {
  state.me = payload.user;
  state.projects = payload.projects;
}

function handleFailure(err) {
  if (err.status === 401) {
    state.me = null;
    loginView();
  } else if (err.code === 'password_change_required') {
    passwordView(true);
  } else {
    render(h('div', { class: 'panel narrow' }, h('p', { class: 'error' }, describe(err))));
  }
}

function show() {
  if (!state.me) return loginView();
  if (state.me.mustChangePassword) return passwordView(true);
  if (state.view === 'password') return passwordView(false);
  if (state.view === 'accounts' && state.me.isAdmin) return void accountsView();
  state.view = 'home';
  homeView();
}

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  state.me = null;
  state.view = 'home';
  loginView();
}

try {
  applyMe(await api('GET', '/api/me'));
  show();
} catch (err) {
  if (err.status === 401) loginView();
  else handleFailure(err);
}
