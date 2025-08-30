'use client';

import { Trash } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ControlledInput } from '@/components/ui/input/controlled-input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface KeyValuePair {
  key: string;
  value: string;
}

interface KeyValueTableProps {
  data: KeyValuePair[];
  onChange: (data: KeyValuePair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  keyLabel?: string;
  valueLabel?: string;
  addLabel?: string;
  hideValue?: boolean;
}

export default function KeyValueTable({
  data,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  keyLabel = 'Key',
  valueLabel = 'Value',
  addLabel = 'Add',
  hideValue = false,
}: KeyValueTableProps) {
  const addRow = () => {
    onChange([...data, { key: '', value: '' }]);
  };

  const removeRow = (index: number) => {
    const newData = data.filter((_, i) => i !== index);
    onChange(newData);
  };

  const updateKey = (index: number, newKey: string) => {
    const newData = [...data];
    newData[index] = { ...newData[index], key: newKey };
    onChange(newData);
  };

  const updateValue = (index: number, newValue: string) => {
    const newData = [...data];
    newData[index] = { ...newData[index], value: newValue };
    onChange(newData);
  };

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{keyLabel}</TableHead>
            {!hideValue && <TableHead>{valueLabel}</TableHead>}
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((item, index) => (
            <TableRow key={index}>
              <TableCell>
                <ControlledInput
                  value={item.key}
                  onValueChanged={(value) => updateKey(index, value)}
                  placeholder={keyPlaceholder}
                  className="border-0 shadow-none focus-visible:ring-0"
                />
              </TableCell>
              {!hideValue && (
                <TableCell>
                  <ControlledInput
                    value={item.value}
                    onValueChanged={(value) => updateValue(index, value)}
                    placeholder={valuePlaceholder}
                    className="border-0 shadow-none focus-visible:ring-0"
                  />
                </TableCell>
              )}
              <TableCell className="w-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(index)}
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell colSpan={hideValue ? 2 : 3}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={addRow}
              >
                {addLabel}
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
