// Default VitePress theme in the colors of Gryffi, with the screenshots of
// the user guide next to the text (shots.js)
import DefaultTheme from 'vitepress/theme';
import { useRoute } from 'vitepress';
import { nextTick, onMounted, watch } from 'vue';
import { initShots } from './shots.js';
import './custom.css';

export default {
  extends: DefaultTheme,
  setup() {
    const route = useRoute();
    onMounted(initShots);
    watch(() => route.path, () => nextTick(initShots));
  }
};
