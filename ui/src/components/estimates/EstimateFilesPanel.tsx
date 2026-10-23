import { useMemo, type ComponentProps } from 'react'
import { useRunProfile } from '@/api/hooks/useProfile'
import { GeneratedFilesPanel, type CategoryInfo, type FileEntry, type TreeNode } from '@/components/run-detail/FilesPanel'

type EstimateFilesPanelProps = Omit<ComponentProps<typeof GeneratedFilesPanel>, 'id' | 'trees' | 'categories'> & {
  estimateId: string
}

/** The entry of a file in the estimate or profile directory of an estimate. */
function buildEntry(directory: 'estimates' | 'profiles', estimateId: string, filename: string, testName = ''): FileEntry {
  const relativePath = testName ? `${testName}/${filename}` : filename
  return {
    testName,
    filename,
    path: `${directory}/${estimateId}/${relativePath}`,
    displayPath: filename,
    outputPath: `${estimateId}/${relativePath}`,
  }
}

const fileNode = (entry: FileEntry, depth: number): TreeNode => ({ id: entry.path, name: entry.filename, type: 'file', entry, depth })

/** The Generated Files panel of an estimate, with the files of the estimate and of its profile. */
export function EstimateFilesPanel({ estimateId, ...downloadListProps }: EstimateFilesPanelProps) {
  const { data: profile } = useRunProfile(estimateId)

  const { trees, categories } = useMemo(() => {
    const generalEntries = [
      buildEntry('estimates', estimateId, 'result.estimate.json'),
      ...(profile ? [buildEntry('profiles', estimateId, 'result.profile.json')] : []),
    ]
    const profileEntries = Object.keys(profile?.tests ?? {}).map((testName) => buildEntry('profiles', estimateId, 'profile.pb.gz', testName))
    const nodes: TreeNode[] = [
      ...generalEntries.map((entry) => fileNode(entry, 0)),
      ...profileEntries.map((entry): TreeNode => ({ id: `dir:${entry.testName}`, name: entry.testName, type: 'directory', children: [fileNode(entry, 1)], depth: 0 })),
    ]
    const categories: CategoryInfo[] = [
      { key: 'general', label: 'General', entries: generalEntries },
      ...(profile ? [{ key: 'profiles', label: 'Profiles', entries: profileEntries }] : []),
    ]
    return { trees: [{ key: 'all', label: 'All', nodes }], categories }
  }, [estimateId, profile])

  return <GeneratedFilesPanel id={estimateId} trees={trees} categories={categories} {...downloadListProps} />
}
