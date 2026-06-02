import { Button } from '@opencroft/ui-kit/button'
import { Input } from '@opencroft/ui-kit/input'
import { Flex } from '@opencroft/ui-kit/layout/flex'
import { Plus, Search, Settings } from 'lucide-react'

interface EDataHeaderProps {
  searchTerm: string
  onSearchChange: (term: string) => void
  onCreate?: () => Promise<void>
  onSettings?: () => Promise<void>
}

export default function DataHeader({ searchTerm, onSearchChange, onCreate, onSettings }: EDataHeaderProps) {
  return (
    <Flex row withGaps className='w-full'>
      <div className='relative flex-1'>
        <Search className='absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground' />
        <Input placeholder={`Filter...`} value={searchTerm} onChange={(e) => onSearchChange(e.target.value)} className='pl-9' />
      </div>
      <Button onClick={onCreate}>
        <Plus />
      </Button>
      {onSettings && (
        <Button variant='outline' onClick={onSettings}>
          <Settings />
        </Button>
      )}
    </Flex>
  )
}
