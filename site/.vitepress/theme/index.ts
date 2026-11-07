import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import Landing from './Landing.vue';
import './brand.css';

export default {
  extends: DefaultTheme,
  // The landing sections follow the hero on the home page.
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-after': () => h(Landing) }),
};
