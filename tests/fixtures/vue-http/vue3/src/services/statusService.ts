import { http } from '../http';

export const listStatuses = () => http.get('statuses'); /* L17 */
export const createStatus = (body: unknown) => http.post('statuses', body); /* L18 */
export const updateStatus = (id: number, body: unknown) => http.put(`statuses/${id}`, body); /* L19 */
export const patchStatus = (id: number, body: unknown) => http.patch(`statuses/${id}`, body); /* L20 */
export const removeStatus = (id: number) => http.delete(`/statuses/${id}`); /* L21 */
export const dailyReport = () => http.get('reports/daily'); /* L22 */
