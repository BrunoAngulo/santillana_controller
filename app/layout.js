import "./globals.css";

export const metadata = {
  title: "Jira Timeline Dashboard",
  description: "Dashboard diario de cambios de tickets por agente en Jira."
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
