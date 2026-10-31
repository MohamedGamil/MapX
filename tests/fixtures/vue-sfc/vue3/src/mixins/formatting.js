export default {
  methods: {
    currency(value, code) {
      return new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(value / 100);
    },
  },
};
