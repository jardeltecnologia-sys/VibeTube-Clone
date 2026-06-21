// Lightweight REST client for SpeedVox. Stores the session token in localStorage.

const TOKEN_KEY = 'speedvox_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(method, path, body, isForm = false) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (isForm) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  register: (d) => request('POST', '/auth/register', d),
  login: (d) => request('POST', '/auth/login', d),
  me: () => request('GET', '/auth/me'),

  searchUsers: (q) => request('GET', `/users/search?q=${encodeURIComponent(q)}`),
  getUser: (id) => request('GET', `/users/${id}`),
  updateProfile: (d) => request('PATCH', '/users/me', d),

  listChats: () => request('GET', '/chats'),
  openDirect: (userId) => request('POST', '/chats/direct', { userId }),
  createGroup: (name, memberIds) => request('POST', '/chats/group', { name, memberIds }),
  getChat: (id) => request('GET', `/chats/${id}`),
  getMessages: (id, before) =>
    request('GET', `/chats/${id}/messages${before ? `?before=${before}` : ''}`),
  leaveChat: (id) => request('POST', `/chats/${id}/leave`),
  updateChat: (id, data) => request('PATCH', `/chats/${id}`, data),
  addMembers: (id, memberIds) => request('POST', `/chats/${id}/members`, { memberIds }),
  removeMember: (id, userId) => request('DELETE', `/chats/${id}/members/${userId}`),
  setMemberRole: (id, userId, role) => request('POST', `/chats/${id}/members/${userId}/role`, { role }),
  pinChat: (id, pinned) => request('POST', `/chats/${id}/pin`, { pinned }),
  archiveChat: (id, archived) => request('POST', `/chats/${id}/archive`, { archived }),
  muteChat: (id, until) => request('POST', `/chats/${id}/mute`, { until }),
  searchMessages: (q, chatId) =>
    request('GET', `/search/messages?q=${encodeURIComponent(q)}${chatId ? `&chatId=${chatId}` : ''}`),
  setDisappearing: (id, seconds) => request('POST', `/chats/${id}/disappearing`, { seconds }),

  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/upload', fd, true);
  },
};
