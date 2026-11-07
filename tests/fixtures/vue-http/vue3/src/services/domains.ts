import axios from 'axios';

// M2-06-R2: the backend serves /ops/v3/status only on Route::domain('ops.example.com').
const reports = axios.create({ baseURL: import.meta.env.VITE_REPORTS_URL });
const ops = axios.create({ baseURL: import.meta.env.VITE_OPS_URL });

export const opsOnApiHost = () => reports.get('ops/v3/status'); /* L47 */
export const opsStatus = () => ops.get('ops/v3/status'); /* L48 */
