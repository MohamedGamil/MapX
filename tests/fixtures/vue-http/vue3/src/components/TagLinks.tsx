// M2-06-R1: a JSX closing tag is not the start of a regex literal.
export const TagLinks = () => <li><a href="/tags">Tags</a> <button onClick={() => fetch('/api/tags')}>Load</button></li>; /* L46 */
