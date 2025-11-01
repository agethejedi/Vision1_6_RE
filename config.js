// Vision config using existing X-Wallet worker as backend
export const VisionConfig = {
  API_BASE: "https://xwalletv1dot2.agedotcom.workers.dev",  // Replace with your deployed X-Wallet worker endpoint
  NETWORKS: {
    eth: { label: "Ethereum" },
    polygon: { label: "Polygon" },
    arbitrum: { label: "Arbitrum" }
  }
};
window.VisionConfig = VisionConfig;
