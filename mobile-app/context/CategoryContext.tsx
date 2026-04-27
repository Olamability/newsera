import React, { createContext, useContext, useState } from 'react';

interface CategoryContextValue {
  selectedCategoryId: string | null;
  setSelectedCategoryId: (id: string | null) => void;
}

const CategoryContext = createContext<CategoryContextValue>({
  selectedCategoryId: null,
  setSelectedCategoryId: () => {},
});

export const CategoryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  return (
    <CategoryContext.Provider value={{ selectedCategoryId, setSelectedCategoryId }}>
      {children}
    </CategoryContext.Provider>
  );
};

export const useCategoryContext = () => useContext(CategoryContext);
