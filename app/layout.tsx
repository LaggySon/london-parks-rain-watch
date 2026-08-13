import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "London Parks Rain Watch",
  description: "Live rainfall outlook and 3D greenness model for five London parks.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body style={{ margin: 0 }}>{children}</body></html>;
}
