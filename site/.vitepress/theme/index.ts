import { h } from 'vue';
// The default theme without its Inter font: the site uses the system font stack (brand.css), so the
// font files would only add 640 KB to the published site.
import DefaultTheme from 'vitepress/theme-without-fonts';
import Landing from './Landing.vue';
import './brand.css';

export default {
  extends: DefaultTheme,
  // The landing sections follow the hero on the home page.
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-after': () => h(Landing) }),
};
