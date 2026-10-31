const MINUTE = 60 * 1000;

export default {
  methods: {
    relativeTime(isoDate) {
      const minutes = Math.round((Date.now() - new Date(isoDate).getTime()) / MINUTE);
      if (minutes < 60) return `${minutes} min ago`;
      return `${Math.round(minutes / 60)} h ago`;
    },
  },
};
