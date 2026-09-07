template <typename T>
class Box {
public:
    T get() const {
        return value_;
    }

private:
    T value_;
};

template <typename T>
T identity(T value) {
    return value;
}

template <>
int identity<int>(int value) {
    return value;
}

int use_identity(int value) {
    return identity<int>(value);
}

using Name = std::string;
typedef unsigned long Size;
