export interface VerticalBoxProps {
  children: React.ReactNode;
  reversed?: boolean;
}

export const VerticalBox = ({ children, reversed }: VerticalBoxProps) => {
  return (
    <div className={`flex flex-col gap-4 ${reversed ? 'flex-col-reverse' : ''}`}>
      {children}
    </div>
  );
};

export default VerticalBox;
