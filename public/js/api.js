// Lightweight REST client for SpeedVox. Stores the session token in localStorage.

import { apiUrl } from './env.js';

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
  const res = await fetch(apiUrl(`/api${path}`), { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data; // expose fields like needsVerification/email to callers
    throw err;
  }
  return data;
}

export const api = {
  register: (d) => request('POST', '/auth/register', d),
  login: (d) => request('POST', '/auth/login', d),
  resendVerification: (email) => request('POST', '/auth/resend-verification', { email }),
  me: () => request('GET', '/auth/me'),

  searchUsers: (q) => request('GET', `/users/search?q=${encodeURIComponent(q)}`),
  matchUsers: (emails) => request('POST', '/users/match', { emails }),
  getUser: (id) => request('GET', `/users/${id}`),
  updateProfile: (d) => request('PATCH', '/users/me', d),
  blockUser: (id) => request('POST', `/users/${id}/block`),
  unblockUser: (id) => request('POST', `/users/${id}/unblock`),
  getBlocks: () => request('GET', '/users/me/blocks'),
  getPrivacy: () => request('GET', '/users/me/privacy'),
  setPrivacy: (d) => request('PATCH', '/users/me/privacy', d),
  listContacts: () => request('GET', '/contacts'),
  addContact: (d) => request('POST', '/contacts', d),
  updateContact: (id, d) => request('PATCH', `/contacts/${id}`, d),
  deleteContact: (id) => request('DELETE', `/contacts/${id}`),
  linkNew: () => request('POST', '/link/new'),
  linkStatus: (code) => request('GET', `/link/status?code=${encodeURIComponent(code)}`),
  linkApprove: (code) => request('POST', '/link/approve', { code }),

  listChats: () => request('GET', '/chats'),
  openSaved: () => request('POST', '/chats/saved'),
  openDirect: (userId) => request('POST', '/chats/direct', { userId }),
  createGroup: (name, memberIds) => request('POST', '/chats/group', { name, memberIds }),
  getChat: (id) => request('GET', `/chats/${id}`),
  getMessages: (id, before) =>
    request('GET', `/chats/${id}/messages${before ? `?before=${before}` : ''}`),
  leaveChat: (id) => request('POST', `/chats/${id}/leave`),
  pinMessage: (id, messageId) => request('POST', `/chats/${id}/pin-message`, { messageId }),
  starMessage: (messageId, starred) => request('POST', `/messages/${messageId}/star`, { starred }),
  starredMessages: () => request('GET', '/messages/starred'),
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
  statusFeed: () => request('GET', '/status'),
  postStatus: (d) => request('POST', '/status', d),
  viewStatus: (id) => request('POST', `/status/${id}/view`),
  statusViewers: (id) => request('GET', `/status/${id}/viewers`),
  deleteStatus: (id) => request('DELETE', `/status/${id}`),
  pushVapid: () => request('GET', '/push/vapid'),
  pushSubscribe: (subscription) => request('POST', '/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint) => request('POST', '/push/unsubscribe', { endpoint }),

  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/upload', fd, true);
  },
};
