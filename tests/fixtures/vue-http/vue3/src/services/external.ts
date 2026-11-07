import axios from 'axios';

// M2-06-R1: host affinity, and fetch methods read only from the top level of the init object.
const reports = axios.create({ baseURL: import.meta.env.VITE_REPORTS_URL });

export const statusPage = () => axios.get('https://status.example.org/api/health'); /* L41 */
export const latestNotices = () => reports.get('api/notices/latest'); /* L42 */
export const pay = () => fetch('/api/posts/search', { headers: {}, body: JSON.stringify({ method: 'POST' }) }); /* L43 */
export const send = (verb: string) => fetch('/api/statuses', { method: verb }); /* L44 */
