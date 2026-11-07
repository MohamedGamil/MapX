export default {
  methods: {
    track(event, id) {
      window.dispatchEvent(new CustomEvent('shop:track', { detail: { event, id } }));
    },
  },
};
