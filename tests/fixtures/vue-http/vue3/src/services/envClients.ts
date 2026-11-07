import axios from 'axios';

// M2-04-R2: base URLs from a quoted .env value with a trailing comment, and from ${VAR} expansion.
const shop = axios.create({ baseURL: import.meta.env.VITE_SHOP_URL });
const billing = axios.create({ baseURL: import.meta.env.VITE_BILLING_URL });

export const shopProducts = () => shop.get('products'); /* L36 */
export const invoices = () => billing.get('v1/invoices'); /* L37 */
