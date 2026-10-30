// A project wrapper MapX cannot recognise as an HTTP client without configuration.
const request = (method: string, url: string) => window.fetch(`/api/${url}`, { method });

export const apiService = {
  get: (url: string) => request('GET', url),
};
