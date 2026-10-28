const errorBox = document.getElementById('login_error');
const formLogin = document.getElementById('formLogin');
const formChange = document.getElementById('formChange');

function showError(msg) {
    errorBox.innerText = msg || '';
}

function showChangeForm(currentPassword) {
    formLogin.classList.add('hidden');
    formChange.classList.remove('hidden');
    document.getElementById('chg_current').value = currentPassword || '';
    document.getElementById(currentPassword ? 'chg_new' : 'chg_current').focus();
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
}

// Si ya hay sesión, al panel directamente (o al cambio de contraseña si está pendiente)
fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(me => {
    if (!me) return;
    if (me.mustChange) showChangeForm('');
    else window.location.href = '/';
}).catch(() => {});

formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const password = document.getElementById('login_pass').value;
    const { ok, data } = await postJson('/api/auth/login', {
        username: document.getElementById('login_user').value.trim(),
        password
    });
    if (!ok) return showError(data.error || 'No se pudo iniciar sesión');
    if (data.mustChange) return showChangeForm(password);
    window.location.href = '/';
});

formChange.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const newPassword = document.getElementById('chg_new').value;
    if (newPassword !== document.getElementById('chg_repeat').value) {
        return showError('Las contraseñas nuevas no coinciden');
    }
    const { ok, data } = await postJson('/api/auth/password', {
        currentPassword: document.getElementById('chg_current').value,
        newPassword
    });
    if (!ok) return showError(data.error || 'No se pudo cambiar la contraseña');
    window.location.href = '/';
});
