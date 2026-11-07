// Pre-2024 date helper; replaced by mixins/timeAgo.js and no longer mixed in anywhere.
export default {
  methods: {
    relativeTime(isoDate) {
      return new Date(isoDate).toLocaleString();
    },
  },
};
