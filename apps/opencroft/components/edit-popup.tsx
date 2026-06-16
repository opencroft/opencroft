'use client'

import { type ComponentType, forwardRef, type ReactNode, type Ref, useImperativeHandle, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { HorizontalBox } from 'ui/layout/horizontal-box'

export interface EditPopupFormProps<T> {
  data?: T
  setData?: (data: T) => void
}

export interface EditPopupRef<T = unknown> {
  open: (title: string, data: T, createMode: boolean) => void
  close: () => void
}

interface EditPopupProps<T> {
  children?: ReactNode
  form: ComponentType<EditPopupFormProps<T>>
  onCreate?: (data: T) => Promise<void>
  onSave?: (data: T) => Promise<void>
  onDelete?: (data: T) => Promise<void>
}

function EditPopup<T>(
  { form: FormComponent, onCreate, onSave, onDelete }: EditPopupProps<T>,
  ref: Ref<EditPopupRef<T>>,
) {
  const [isOpen, setIsOpen] = useState(false)
  const [title, setTitle] = useState('Edit')
  const [data, setData] = useState<T | undefined>()
  const [createMode, setCreateMode] = useState(false)

  const handleClose = () => {
    setIsOpen(false)
  }

  const handleSave = async () => {
    handleClose()
    if (data && onSave) {
      await onSave(data)
    }
  }

  const handleCreate = async () => {
    handleClose()
    if (data && onCreate) {
      await onCreate(data)
    }
  }

  const handleDeletion = async () => {
    handleClose()
    if (data && onDelete) {
      await onDelete(data)
    }
  }

  useImperativeHandle(ref, () => ({
    open: (title: string, data: T, createMode: boolean = false) => {
      setTitle(title)
      setData(data)
      setCreateMode(createMode)
      setIsOpen(true)
    },
    close: handleClose,
  }))

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className='sm:max-w-7xl'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <FormComponent data={data} setData={setData} />
        <HorizontalBox reversed={true}>
          {createMode ? (
            <Button onClick={handleCreate}>Create</Button>
          ) : (
            <>
              {onDelete ? (
                <Button variant={'destructive'} onClick={handleDeletion}>
                  Delete
                </Button>
              ) : (
                ''
              )}
              <Button onClick={handleSave}>Save</Button>
            </>
          )}
        </HorizontalBox>
      </DialogContent>
    </Dialog>
  )
}

export default forwardRef(EditPopup)
