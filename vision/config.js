// Vision config using existing X-Wallet worker as backend
export const VisionConfig = {
  API_BASE: "https://your-xwallet-worker-url",  // Replace with your deployed X-Wallet worker endpoint
  NETWORKS: {
    eth: { label: "Ethereum" },
    polygon: { label: "Polygon" },
    arbitrum: { label: "Arbitrum" }
  }
};
window.VisionConfig = VisionConfig;
