import axios from 'axios';

// M2-06-R4: the host is named only by the partners-api app's Route::domain('partners.example.com').
export const partnerFeed = () => axios.get('https://partners.example.com/partners/v1/feed'); /* L49 */
// Only the backend app serves /api/notices/latest, with no domain; partners-api alone declares the host.
export const partnerNotices = () => axios.get('https://partners.example.com/api/notices/latest'); /* L50 */
