import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/react'
import clsx from 'clsx'

export interface DashboardTabOption<T extends string> {
  value: T
  label: string
  icon: React.ReactNode
}

interface DashboardTabsProps<T extends string> {
  tabs: DashboardTabOption<T>[]
  activeTab: T
  onTabChange: (tab: T) => void
  children: React.ReactNode
}

export function DashboardTabs<T extends string>({ tabs, activeTab, onTabChange, children }: DashboardTabsProps<T>) {
  const tabIndex = Math.max(0, tabs.findIndex((t) => t.value === activeTab))

  const handleTabChange = (index: number) => {
    onTabChange(tabs[index].value)
  }

  return (
    <TabGroup key={activeTab} selectedIndex={tabIndex} onChange={handleTabChange}>
      <TabList className="flex border-b border-gray-200 dark:border-gray-700">
        {tabs.map((tab) => (
          <Tab
            key={tab.value}
            className={({ selected }) =>
              clsx(
                'flex cursor-pointer items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus:outline-hidden',
                selected
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              )
            }
          >
            {tab.icon}
            {tab.label}
          </Tab>
        ))}
      </TabList>
      <TabPanels className="p-4">
        {children}
      </TabPanels>
    </TabGroup>
  )
}

export { TabPanel }
