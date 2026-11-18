export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  const options = {
    method,
    credentials: 'include',
    headers: {},
  };

  if (body instanceof Blob) {
    options.body = body;
    options.headers['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    options.body = body;
    options.headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError('Нет соединения с сервером', 0, 'NETWORK');
  }

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : null;

  if (!response.ok) {
    throw new ApiError(
      data?.error || `Ошибка сервера (${response.status})`,
      response.status,
      data?.code,
    );
  }

  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
  upload: (path, bytes) => request('POST', path, bytes),
};

export const AUTH_ERRORS = {
  google_cancelled: 'Вход через Google отменён.',
  google_failed: 'Не удалось войти через Google. Попробуйте ещё раз.',
  google_disabled: 'Google OAuth не настроен на этом сервере.',
  oauth_state: 'Сессия входа истекла. Попробуйте снова.',
  no_channel: 'В Google-аккаунте не найден YouTube-канал. Привяжите канал по коду.',
  channel_taken: 'Этот YouTube-канал уже привязан к другому аккаунту.',
  full: 'Все 100 мест уже заняты.',
  banned: 'Этот аккаунт заблокирован администратором.',
  link_failed: 'Не удалось привязать YouTube-канал. Попробуйте позже.',
};
