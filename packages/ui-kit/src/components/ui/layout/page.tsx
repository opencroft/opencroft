export interface PageProps {
  children: React.ReactNode;
}

export function Page({ children }: PageProps) {
  return (
    <div className="flex-1 p-2">
      {children}
    </div>
  );
}
