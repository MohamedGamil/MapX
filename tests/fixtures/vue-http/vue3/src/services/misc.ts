import { http } from '../http';

export const newCategoryForm = () => http.get('blog-categories/create'); /* L23 */
export const editCategoryForm = (slug: string) => http.get(`blog-categories/${slug}/edit`); /* L24 */
export const products = () => fetch('/shop/products'); /* L25 */
export const about = () => fetch('/about'); /* L26 */
export const tag = (name: string) => fetch(`/api/tags/${name}`); /* L27 */
