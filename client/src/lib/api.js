import axios from 'axios';

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

// The access token lives in memory only; the refresh token is an httpOnly
// cookie, so a page reload re-derives the session from /auth/refresh.
let accessToken = null;
let onAuthLost = () => {};

export const setAccessToken = (t) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setAuthLostHandler = (fn) => { onAuthLost = fn; };

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

// A single in-flight refresh is shared by every request that 401s, so a burst
// of parallel calls cannot each rotate the refresh token and revoke the family.
let refreshing = null;

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const isAuthCall = original?.url?.includes('/auth/');

    if (status === 401 && !original?._retried && !isAuthCall) {
      original._retried = true;
      try {
        refreshing = refreshing ?? api.post('/auth/refresh').finally(() => { refreshing = null; });
        const { data } = await refreshing;
        setAccessToken(data.accessToken);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(original);
      } catch {
        setAccessToken(null);
        onAuthLost();
      }
    }
    return Promise.reject(error);
  },
);

// Surfaces the server's error envelope, including zod field details.
export const errorMessage = (error) => {
  const data = error?.response?.data;
  if (!data) return error?.message ?? 'Something went wrong';
  if (data.details?.length && Array.isArray(data.details)) {
    const first = data.details[0];
    return first.path ? `${first.path}: ${first.message}` : data.error;
  }
  return data.error ?? 'Request failed';
};

/*
 * Downloads a file from an authenticated endpoint.
 *
 * The CSV routes need the bearer token, so a plain <a href> cannot fetch them -
 * the response has to be read as a blob and handed to a synthetic link. The
 * filename comes from the server's Content-Disposition so it carries the date
 * stamp the API chose.
 */
export async function downloadFile(path, params, fallbackName) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    query.set(k, String(v));
  }
  const qs = query.toString();

  const res = await fetch(`/api${path}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  if (!res.ok) throw new Error('Export failed');

  const disposition = res.headers.get('Content-Disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition)?.[1];

  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = named ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
