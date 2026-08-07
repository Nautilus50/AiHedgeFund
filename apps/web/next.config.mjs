/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@arf-os/ui", "@arf-os/contracts"],
};

export default nextConfig;
