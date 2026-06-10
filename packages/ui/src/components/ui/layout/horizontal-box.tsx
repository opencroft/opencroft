export interface HorizontalBoxProps {
  children: React.ReactNode;
  reversed?: boolean;
}

export const HorizontalBox = ({ children, reversed }: HorizontalBoxProps) => {
  return (
    <div className={`flex gap-4 ${reversed ? 'flex-row-reverse' : ''}`}>
      {children}
    </div>
  );
};

export default HorizontalBox;
