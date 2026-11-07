import { GUIDE_META } from '../../scripts/site/sync-docs';

/** The docs sidebar, built from the same guide list that decides what is published (M7-02). */
export function docsSidebar() {
  const groups = [...new Set(GUIDE_META.map((g) => g.group))];
  return [
    { text: 'Overview', items: [{ text: 'All guides', link: '/docs/' }] },
    ...groups.map((group) => ({
      text: group,
      items: GUIDE_META.filter((g) => g.group === group).map((g) => ({ text: g.label, link: `/docs/${g.name}` })),
    })),
  ];
}
